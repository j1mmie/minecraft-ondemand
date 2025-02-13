import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'yaml'
import { fromError } from 'zod-validation-error'

import { Config, configSchema } from './config-schema'

export function resolveConfig():Config {
  const resolvedPath = path.resolve('config.yml')
  const rawFileContents = fs.readFileSync(resolvedPath, 'utf8')

  let parsedYaml:any
  try {
    parsedYaml = yaml.parse(rawFileContents)
  } catch (e) {
    throw new Error(
      `Unable to parse yaml file at path ${resolvedPath}. Canceling deploy so that you can fix these errors.\n\nParser Error: ${(e as any).message}`
    )
  }

  const validatedYaml = configSchema.safeParse(parsedYaml)
  if (!validatedYaml.success) {
    throw new Error(
      `Invalid yaml file at path ${resolvedPath}. Canceling deploy so that you can fix these errors.\n\nValidation Errors: ${fromError(validatedYaml.error)}`
    )
  }

  return validatedYaml.data
}
