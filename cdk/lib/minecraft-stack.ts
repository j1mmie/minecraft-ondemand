import * as path from 'path';
import {
  Stack,
  StackProps,
  aws_ec2 as ec2,
  aws_efs as efs,
  aws_iam as iam,
  aws_ecs as ecs,
  aws_logs as logs,
  aws_sns as sns,
  RemovalPolicy,
  Arn,
  ArnFormat,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { constants } from './constants';
import { SSMParameterReader } from './ssm-parameter-reader';
import { getMinecraftServerConfig, isDockerInstalled } from './util';
import { Config } from './config-schema'

interface MinecraftStackProps extends StackProps {
  config: Readonly<Config>;
}

const watchdogMemoryRequiredMiB = 512;

export class MinecraftStack extends Stack {
  constructor(scope: Construct, id: string, props: MinecraftStackProps) {
    super(scope, id, props);

    const { config } = props;

    const vpc = config.vpcId
      ? ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: config.vpcId })
      : new ec2.Vpc(this, 'Vpc', {
          maxAzs: 3,
          natGateways: 0,
        });

    const fileSystem = new efs.FileSystem(this, 'FileSystem', {
      vpc,
      removalPolicy: RemovalPolicy.SNAPSHOT,
    });

    const accessPoint = new efs.AccessPoint(this, 'AccessPoint', {
      fileSystem,
      path: '/minecraft',
      posixUser: {
        uid: '1000',
        gid: '1000',
      },
      createAcl: {
        ownerGid: '1000',
        ownerUid: '1000',
        permissions: '0755',
      },
    });

    const efsReadWriteDataPolicy = new iam.Policy(this, 'DataRWPolicy', {
      statements: [
        new iam.PolicyStatement({
          sid: 'AllowReadWriteOnEFS',
          effect: iam.Effect.ALLOW,
          actions: [
            'elasticfilesystem:ClientMount',
            'elasticfilesystem:ClientWrite',
            'elasticfilesystem:DescribeFileSystems',
          ],
          resources: [fileSystem.fileSystemArn],
          conditions: {
            StringEquals: {
              'elasticfilesystem:AccessPointArn': accessPoint.accessPointArn,
            },
          },
        }),
      ],
    });

    const ecsTaskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Minecraft ECS task role',
    });

    efsReadWriteDataPolicy.attachToRole(ecsTaskRole);

    const cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: constants.CLUSTER_NAME,
      vpc,
      containerInsights: true, // TODO: Add config for container insights
      enableFargateCapacityProviders: true,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      'TaskDefinition',
      {
        taskRole: ecsTaskRole,
        memoryLimitMiB: config.taskMemory,
        cpu: config.taskCpu,
        volumes: [
          {
            name: constants.ECS_VOLUME_NAME,
            efsVolumeConfiguration: {
              fileSystemId: fileSystem.fileSystemId,
              transitEncryption: 'ENABLED',
              authorizationConfig: {
                accessPointId: accessPoint.accessPointId,
                iam: 'ENABLED',
              },
            },
          },
        ],
      }
    );

    const totalMemoryAvailableMiB = config.taskMemory;
    const minecraftServerMemoryMiB = totalMemoryAvailableMiB - watchdogMemoryRequiredMiB;

    const minecraftServerConfig = getMinecraftServerConfig()

    const minecraftServerContainer = new ecs.ContainerDefinition(
      this,
      'ServerContainer',
      {
        containerName: constants.MC_SERVER_CONTAINER_NAME,
        cpu: 1024,
        memoryLimitMiB: minecraftServerMemoryMiB,
        memoryReservationMiB: minecraftServerMemoryMiB - 256,
        image: ecs.ContainerImage.fromRegistry(minecraftServerConfig.image),
        portMappings: [
          {
            containerPort: minecraftServerConfig.port,
            hostPort: minecraftServerConfig.port,
            protocol: minecraftServerConfig.protocol,
          },
          ...config.extraTcpPorts.map(port => ({
            containerPort: port,
            hostPort: port,
            protocol: ecs.Protocol.TCP,
          })),
          ...config.extraUdpPorts.map(port => ({
            containerPort: port,
            hostPort: port,
            protocol: ecs.Protocol.UDP,
          })),
        ],
        environment: config.serverEnvironment,
        essential: false,
        taskDefinition,
        logging: config.debug
          ? new ecs.AwsLogDriver({
              logRetention: logs.RetentionDays.THREE_DAYS,
              streamPrefix: constants.MC_SERVER_CONTAINER_NAME,
            })
          : undefined,
      }
    );

    minecraftServerContainer.addMountPoints({
      containerPath: '/data',
      sourceVolume: constants.ECS_VOLUME_NAME,
      readOnly: false,
    });

    const serviceSecurityGroup = new ec2.SecurityGroup(
      this,
      'ServiceSecurityGroup',
      {
        vpc,
        description: 'Security group for Minecraft on-demand',
      }
    );

    serviceSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      minecraftServerConfig.ingressRulePort
    );

    config.extraTcpPorts.forEach(port => {
      serviceSecurityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(port)
      );
    });

    config.extraUdpPorts.forEach(port => {
      serviceSecurityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.udp(port)
      );
    });

    const minecraftServerService = new ecs.FargateService(
      this,
      'FargateService',
      {
        cluster,
        capacityProviderStrategies: [
          {
            capacityProvider: config.useFargateSpot
              ? 'FARGATE_SPOT'
              : 'FARGATE',
            weight: 1,
            base: 1,
          },
        ],
        taskDefinition: taskDefinition,
        platformVersion: ecs.FargatePlatformVersion.LATEST,
        serviceName: constants.SERVICE_NAME,
        desiredCount: 0,
        assignPublicIp: true,
        securityGroups: [serviceSecurityGroup],
      }
    );

    /* Allow access to EFS from Fargate service security group */
    fileSystem.connections.allowDefaultPortFrom(
      minecraftServerService.connections
    );

    const hostedZoneId = new SSMParameterReader(
      this,
      'Route53HostedZoneIdReader',
      {
        parameterName: constants.HOSTED_ZONE_SSM_PARAMETER,
        region: constants.DOMAIN_STACK_REGION,
      }
    ).getParameterValue();

    let snsTopicArn = '';
    /* Create SNS Topic if SNS_EMAIL is provided */
    if (config.snsEmailAddress) {
      const snsTopic = new sns.Topic(this, 'ServerSnsTopic', {
        displayName: 'Minecraft Server Notifications',
      });

      snsTopic.grantPublish(ecsTaskRole);

      const emailSubscription = new sns.Subscription(
        this,
        'EmailSubscription',
        {
          protocol: sns.SubscriptionProtocol.EMAIL,
          topic: snsTopic,
          endpoint: config.snsEmailAddress,
        }
      );
      snsTopicArn = snsTopic.topicArn;
    }

    const watchdogEnv:Record<string, string> = {
      CLUSTER: constants.CLUSTER_NAME,
      SERVICE: constants.SERVICE_NAME,
      DNSZONE: hostedZoneId,
      SERVERNAME: `${config.subdomainPart}.${config.domainName}`,
      SNSTOPIC: snsTopicArn,
      STARTUPMIN: config.startupMinutes.toString(),
      SHUTDOWNMIN: config.shutdownMinutes.toString(),
    }

    if (config.discord) {
      watchdogEnv.DISCORDWEBHOOKS = config.discord.webhookUrls.join(',')
    }

    if (config.twilio) {
      watchdogEnv.TWILIOFROM = config.twilio.phoneFrom
      watchdogEnv.TWILIOTO   = config.twilio.phoneTo
      watchdogEnv.TWILIOAID  = config.twilio.accountId
      watchdogEnv.TWILIOAUTH = config.twilio.authCode
    }

    const watchdogContainer = new ecs.ContainerDefinition(
      this,
      'WatchDogContainer',
      {
        containerName: constants.WATCHDOG_SERVER_CONTAINER_NAME,
        cpu: 1024,
        memoryLimitMiB: watchdogMemoryRequiredMiB,
        memoryReservationMiB: watchdogMemoryRequiredMiB - 128,
        image: isDockerInstalled()
          ? ecs.ContainerImage.fromAsset(
              path.resolve(__dirname, '../../minecraft-ecsfargate-watchdog/')
            )
          : ecs.ContainerImage.fromRegistry(
              'j1mmie/minecraft-ecsfargate-watchdog'
            ),
        essential: true,
        taskDefinition: taskDefinition,
        environment: watchdogEnv,
        logging: config.debug
          ? new ecs.AwsLogDriver({
              logRetention: logs.RetentionDays.THREE_DAYS,
              streamPrefix: constants.WATCHDOG_SERVER_CONTAINER_NAME,
            })
          : undefined,
      }
    );

    const serviceControlPolicy = new iam.Policy(this, 'ServiceControlPolicy', {
      statements: [
        new iam.PolicyStatement({
          sid: 'AllowAllOnServiceAndTask',
          effect: iam.Effect.ALLOW,
          actions: ['ecs:*'],
          resources: [
            minecraftServerService.serviceArn,
            /* arn:aws:ecs:<region>:<account_number>:task/minecraft/* */
            Arn.format(
              {
                service: 'ecs',
                resource: 'task',
                resourceName: `${constants.CLUSTER_NAME}/*`,
                arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
              },
              this
            ),
          ],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['ec2:DescribeNetworkInterfaces'],
          resources: ['*'],
        }),
      ],
    });

    serviceControlPolicy.attachToRole(ecsTaskRole);

    /**
     * Add service control policy to the launcher lambda from the other stack
     */
    const launcherLambdaRoleArn = new SSMParameterReader(
      this,
      'launcherLambdaRoleArn',
      {
        parameterName: constants.LAUNCHER_LAMBDA_ARN_SSM_PARAMETER,
        region: constants.DOMAIN_STACK_REGION,
      }
    ).getParameterValue();
    const launcherLambdaRole = iam.Role.fromRoleArn(
      this,
      'LauncherLambdaRole',
      launcherLambdaRoleArn
    );
    serviceControlPolicy.attachToRole(launcherLambdaRole);

    /**
     * This policy gives permission to our ECS task to update the A record
     * associated with our minecraft server. Retrieve the hosted zone identifier
     * from Route 53 and place it in the Resource line within this policy.
     */
    const iamRoute53Policy = new iam.Policy(this, 'IamRoute53Policy', {
      statements: [
        new iam.PolicyStatement({
          sid: 'AllowEditRecordSets',
          effect: iam.Effect.ALLOW,
          actions: [
            'route53:GetHostedZone',
            'route53:ChangeResourceRecordSets',
            'route53:ListResourceRecordSets',
          ],
          resources: [`arn:aws:route53:::hostedzone/${hostedZoneId}`],
        }),
      ],
    });
    iamRoute53Policy.attachToRole(ecsTaskRole);
  }
}
