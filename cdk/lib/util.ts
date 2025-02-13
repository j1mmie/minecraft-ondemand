import { Port } from 'aws-cdk-lib/aws-ec2'
import { Protocol } from 'aws-cdk-lib/aws-ecs'
import * as execa from 'execa'
import { constants } from './constants'

export function isDockerInstalled():boolean {
  try {
    execa.sync('docker', ['version'])
    return true
  } catch (e) {
    return false
  }
}

export function getMinecraftServerConfig() {
  return {
    image:           constants.JAVA_EDITION_DOCKER_IMAGE,
    port:            constants.JAVA_EDITION_DEFAULT_PORT,
    protocol:        Protocol.TCP,
    ingressRulePort: Port.tcp(constants.JAVA_EDITION_DEFAULT_PORT),
  }
}
