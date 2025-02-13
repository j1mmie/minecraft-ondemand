import { z } from 'zod'

export const twilioConfigSchema = z.object({
  phoneFrom: z.string(),
  phoneTo:   z.string(),
  accountId: z.string(),
  authCode:  z.string()
})

export const discordConfigSchema = z.object({
  webhookUrls: z.array(z.string())
})

const stringArrayKeys = ['MODS', 'PLUGINS']

function serverEnvironmentTransform(input:any):Record<string, string> {
  return Object.entries(input).map(([key, value]) => {
    if (stringArrayKeys.includes(key) && Array.isArray(value)) {
      return [key, value.join(',')]
    } else {
      return [key, String(value)]
    }
  }).reduce((acc, [key, value]) => {
    acc[key] = value
    return acc
  }, {} as Record<string, string>)
}

export const configSchema = z.object({
  domainName:        z.string(),
  subdomainPart:     z.string().default('mc'),
  serverRegion:      z.string().default('us-west-1'),
  startupMinutes:    z.number().default(10),
  shutdownMinutes:   z.number().default(20),
  useFargateSpot:    z.boolean().default(false),
  taskCpu:           z.number().default(1024),
  taskMemory:        z.number().default(2048),
  vpcId:             z.string().optional(),
  snsEmailAddress:   z.string().optional(),
  twilio:            twilioConfigSchema.optional(),
  discord:           discordConfigSchema.optional(),
  serverEnvironment: z.record(z.string(), z.any()).transform(serverEnvironmentTransform),
  debug:             z.boolean().default(false),
  extraTcpPorts:     z.array(z.number()).default([]),
  extraUdpPorts:     z.array(z.number()).default([])
})

export type Config = z.infer<typeof configSchema>
