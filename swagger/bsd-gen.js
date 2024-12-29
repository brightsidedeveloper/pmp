const fs = require('fs')
const path = require('path')
const chalk = require('chalk')
const ora = require('ora')
const yaml = require('js-yaml')
const { log } = require('console')
require('dotenv').config()

const apiFilePath = './swagger/api.yaml'
const webApiDir = './web/src/api'
const nativeApiDir = './native/api'
const desktopApiDir = './desktop/frontend/src/api'
const goApiDir = '../server/api'
const outputBSDFile = 'ez.ts'
const outputTypesFile = 'types.ts'
const webDesktopRequestFilePath = './swagger/util/request.web.ts'
const nativeRequestFilePath = './swagger/util/request.native.ts'
const origin = process.env.SWAG_ORIGIN
if (!origin) {
  console.error(chalk.red('Error: Please set the ORIGIN environment variable'))
  process.exit(1)
}

const logStep = (message) => {
  const spinner = ora(chalk.greenBright(message)).start()
  return spinner
}

// Utility function to capitalize the first letter of a string
const capitalize = (str) => str.charAt(0).toUpperCase() + str.slice(1)

// Utility function to convert a string to PascalCase
const toPascalCase = (str) => str.replace(/(^\w|-\w)/g, (match) => match.replace('-', '').toUpperCase()).replace(/[^a-zA-Z0-9]/g, '')

// Function to generate TypeScript types from OpenAPI JSON
// Function to map OpenAPI types to TypeScript types
const mapOpenApiTypeToTsType = (type, items) => {
  if (type === 'integer') return 'number'
  if (type === 'array') {
    const itemType = items?.$ref ? toPascalCase(items.$ref.split('/').pop()) : mapOpenApiTypeToTsType(items?.type || 'unknown')
    return `${itemType}[]`
  }
  return type || 'unknown' // Default to the OpenAPI type for string, boolean, etc.
}

const generateTypes = (apiJson) => {
  const components = apiJson.components.schemas

  const generateInlineType = (schema, parentName) => {
    if (!schema.properties) return 'unknown'
    return `{\n${Object.entries(schema.properties)
      .map(([propName, propSchema]) => {
        const tsType = mapOpenApiTypeToTsType(propSchema.type, propSchema.items)
        return `  ${propName}${schema.required?.includes(propName) ? '' : '?'}: ${tsType};`
      })
      .join('\n')}\n}`
  }

  // Extract version from the first path (assuming consistent versioning in all paths)
  const versionMatch = Object.keys(apiJson.paths)[0].match(/\/(v\d+)/)
  const version = versionMatch ? versionMatch[1] : 'UnknownVersion'
  const capitalize = (str) => str.charAt(0).toUpperCase() + str.slice(1)

  // Generate schema types with version prepended
  const schemaTypes = Object.entries(components)
    .map(([name, schema]) => {
      const typeName = `${capitalize(version)}${toPascalCase(name)}`
      const properties = Object.entries(schema.properties || {})
        .map(([propName, propSchema]) => {
          let tsType
          if (propSchema.type === 'array' && propSchema.items?.type === 'object') {
            tsType = `Array<${generateInlineType(propSchema.items, `${typeName}${capitalize(propName)}Item`)}>`
          } else {
            tsType = mapOpenApiTypeToTsType(propSchema.type, propSchema.items)
          }
          return `  ${propName}${schema.required?.includes(propName) ? '' : '?'}: ${tsType};`
        })
        .join('\n')

      return `export type ${typeName} = {\n${properties}\n}`
    })
    .join('\n\n')

  // Generate query parameter types with version prepended
  const parameterTypes = Object.entries(apiJson.paths)
    .flatMap(([path, methods]) =>
      Object.entries(methods).flatMap(([method, details]) => {
        if (!details.parameters) return []
        const operationId = details.operationId ? capitalize(details.operationId) : 'UnnamedOperation'
        const typeName = `${capitalize(version)}${operationId}Params`

        const properties = details.parameters
          .map((param) => {
            const tsType = mapOpenApiTypeToTsType(param.schema.type, param.schema.items)
            return `  ${param.name}${param.required ? '' : '?'}: ${tsType};`
          })
          .join('\n')

        return `export type ${typeName} = {\n${properties}\n}`
      })
    )
    .join('\n\n')

  return `
  /**
   * Auto-generated File - BSD
   */
  
  ${schemaTypes}

  ${parameterTypes}
  `
}

const generateApiClient = (apiJson) => {
  const classes = { Get: [], Post: [], Put: [], Patch: [], Delete: [] }

  // Extract version from the first path (assuming consistent versioning in all paths)
  const versionMatch = Object.keys(apiJson.paths)[0].match(/\/(v\d+)/)
  const version = versionMatch ? versionMatch[1] : 'UnknownVersion'
  const capitalize = (str) => str.charAt(0).toUpperCase() + str.slice(1)

  const parameterTypes = Object.entries(apiJson.paths)
    .flatMap(([path, methods]) =>
      Object.entries(methods).flatMap(([method, details]) => {
        if (!details.parameters) return []
        const operationId = details.operationId ? capitalize(details.operationId) : 'UnnamedOperation'
        return `${capitalize(version)}${operationId}Params`
      })
    )
    .filter((typeName, index, self) => self.indexOf(typeName) === index) // Remove duplicates

  let usedMethods = new Set([])
  Object.entries(apiJson.paths).forEach(([path, methods]) => {
    Object.entries(methods).forEach(([method, details]) => {
      usedMethods = new Set([...usedMethods, method])
      const className = capitalize(method)
      const operationId = details.operationId ? capitalize(details.operationId) : 'UnnamedOperation'
      const functionName = `${version}${operationId}`
      const responseSchema = details.responses?.['200']?.content?.['application/json']?.schema
      const responseType = responseSchema
        ? responseSchema.$ref
          ? `${capitalize(version)}${toPascalCase(responseSchema.$ref.split('/').pop())}`
          : mapOpenApiTypeToTsType(responseSchema.type, responseSchema.items)
        : 'void'

      const paramSchema = details.parameters?.length
        ? `${capitalize(version)}${operationId}Params`
        : details.requestBody?.content?.['application/json']?.schema?.$ref
        ? `${capitalize(version)}${toPascalCase(details.requestBody.content['application/json'].schema.$ref.split('/').pop())}`
        : null

      const paramsType = paramSchema ? `params: ${paramSchema}` : ''
      const requestArgs = paramSchema ? `\`${path}\`, params` : `\`${path}\``

      const jsdoc = `
        /**
         * ${details.summary || 'No description provided'}
         * @returns {Promise<${responseType}>}
         */
      `.trim()

      classes[className].push(`
        ${jsdoc}
        static async ${functionName}(${paramsType}) {
          return ${method}<${responseType}>(${requestArgs});
        }
      `)
    })
  })

  const classCode = Object.entries(classes)
    .map(
      ([className, methods]) => `
  class ${className} {
    ${methods.join('\n  ')}
  }
  `
    )
    .join('\n')

  return `
  /**
   * Auto-generated File - BSD
   */

  import { ${Array.from(usedMethods).join(', ')} } from './request';
  import { ${[
    ...Object.keys(apiJson.components.schemas).map((name) => `${capitalize(version)}${toPascalCase(name)}`),
    ...parameterTypes,
  ].join(', ')} } from './types';

  ${classCode}

  export default class ez {
    static get = Get;
    static post = Post;
    static put = Put;
    static patch = Patch;
    static delete = Delete;
  }
  `
}

const generateQueries = (apiJson) => {
  // Extract version from the first path (assuming consistent versioning in all paths)
  const versionMatch = Object.keys(apiJson.paths)[0].match(/\/(v\d+)/)
  const version = versionMatch ? versionMatch[1] : 'UnknownVersion'

  const queries = Object.entries(apiJson.paths)
    .flatMap(([path, methods]) =>
      Object.entries(methods).flatMap(([method, details]) => {
        if (method.toLowerCase() !== 'get') return []
        const operationId = details.operationId ? capitalize(details.operationId) : 'UnnamedOperation'
        const functionName = `create${version.toUpperCase()}${operationId}Query`
        const paramsType = details.parameters?.length ? `${version.toUpperCase()}${operationId}Params` : null

        const paramsArg = paramsType ? `params: ${paramsType}, ` : ''
        return `
export function ${functionName}<TData = Awaited<ReturnType<typeof ez.get.${version}${operationId}>>, TError = Error>(${paramsArg}opts: Omit<UseQueryOptions<Awaited<ReturnType<typeof ez.get.${version}${operationId}>>, TError, TData, ${version.toUpperCase()}${operationId}QueryKey>, 'queryKey' | 'queryFn'> = {}) {
  return queryOptions({
    ...opts,
    queryKey: get${version.toUpperCase()}${operationId}QueryKey(${paramsType ? 'params' : ''}),
    queryFn() {
      return ez.get.${version}${operationId}(${paramsType ? 'params' : ''});
    },
  });
}
export function get${version.toUpperCase()}${operationId}QueryKey(${paramsType ? 'params: ' + paramsType : ''}) {
  return ['${operationId.toLowerCase()}'${paramsType ? ', params' : ''}] as const;
}
export type ${version.toUpperCase()}${operationId}QueryKey = ReturnType<typeof get${version.toUpperCase()}${operationId}QueryKey>;
`
      })
    )
    .join('\n\n')

  return `
/**
 * Auto-generated File - BSD
 */

import { UseQueryOptions, queryOptions } from '@tanstack/react-query';
import ez from './ez';
import { ${[
    ...Object.entries(apiJson.paths)
      .flatMap(([_, methods]) =>
        Object.entries(methods).flatMap(([method, details]) =>
          method.toLowerCase() === 'get' && details.parameters
            ? `${capitalize(version)}${capitalize(details.operationId || 'UnnamedOperation')}Params`
            : []
        )
      )
      .filter((typeName, index, self) => self.indexOf(typeName) === index),
  ]} } from './types';

${queries}
`
}

const generateGoStructs = (apiJson) => {
  const components = apiJson.components.schemas

  const nestedStructs = [] // To store generated nested structs

  const mapOpenApiTypeToGoType = (type, items, parentStructName, propName) => {
    if (type === 'integer') return 'int'
    if (type === 'number') return 'float64'
    if (type === 'string') return 'string'
    if (type === 'boolean') return 'bool'
    if (type === 'array') {
      const arrayItemType = items?.$ref
        ? `[]${toPascalCase(items.$ref.split('/').pop())}`
        : items?.type === 'object'
        ? `[]${generateNestedStructFromObject(parentStructName, propName, items)}`
        : `[]${mapOpenApiTypeToGoType(items.type, items.items, parentStructName, propName)}`
      return arrayItemType
    }
    if (type === 'object') {
      return generateNestedStructFromObject(parentStructName, propName, { properties: items })
    }
    return 'interface{}' // Default fallback
  }

  const generateNestedStructFromObject = (parentStructName, propName, schema) => {
    const structName = `${parentStructName}${capitalize(propName)}`
    if (nestedStructs.find((nested) => nested.name === structName)) {
      return structName // Avoid duplicate struct definitions
    }
    const fields = Object.entries(schema.properties || {})
      .map(([fieldName, fieldSchema]) => {
        const goType = fieldSchema.$ref
          ? `V1${toPascalCase(fieldSchema.$ref.split('/').pop())}`
          : mapOpenApiTypeToGoType(fieldSchema.type, fieldSchema.items, structName, fieldName)
        const jsonTag = `\`${'json:' + '"' + fieldName + '"'}\``
        return `  ${capitalize(fieldName)} ${goType} ${jsonTag}`
      })
      .join('\n')

    nestedStructs.push({ name: structName, definition: `type ${structName} struct {\n${fields}\n}` })
    return structName
  }

  const generateStruct = (name, schema) => {
    const structName = `V1${toPascalCase(name)}`
    const fields = Object.entries(schema.properties || {})
      .map(([propName, propSchema]) => {
        const goType = propSchema.$ref
          ? `V1${toPascalCase(propSchema.$ref.split('/').pop())}`
          : mapOpenApiTypeToGoType(propSchema.type, propSchema.items, structName, propName)
        const jsonTag = `\`${'json:' + '"' + propName + '"'}\``
        return `  ${capitalize(propName)} ${goType} ${jsonTag}`
      })
      .join('\n')
    return `type ${structName} struct {\n${fields}\n}`
  }

  const structs = Object.entries(components)
    .map(([name, schema]) => generateStruct(name, schema))
    .join('\n\n')

  const allStructs = [...nestedStructs.map((s) => s.definition), structs]

  return `// Auto-generated File - BSD\n\npackage api\n\n${allStructs.join('\n\n')}`
}

console.log(
  chalk.blueBright(`
    ███╗░░░███╗░█████╗░██╗░░██╗███████╗  ██████╗░░██████╗██████╗░
    ████╗░████║██╔══██╗██║░██╔╝██╔════╝  ██╔══██╗██╔════╝██╔══██╗
    ██╔████╔██║███████║█████═╝░█████╗░░  ██████╦╝╚█████╗░██║░░██║
    ██║╚██╔╝██║██╔══██║██╔═██╗░██╔══╝░░  ██╔══██╗░╚═══██╗██║░░██║
    ██║░╚═╝░██║██║░░██║██║░╚██╗███████╗  ██████╦╝██████╔╝██████╔╝
    ╚═╝░░░░░╚═╝╚═╝░░╚═╝╚═╝░░╚═╝╚══════╝  ╚═════╝░╚═════╝░╚═════╝░ 
`)
)

const loadApiYaml = () => {
  try {
    const yamlContent = fs.readFileSync(apiFilePath, 'utf8')
    const apiJson = yaml.load(yamlContent) // Parse YAML into a JavaScript object
    return apiJson
  } catch (err) {
    console.error(chalk.red('Failed to load API YAML:'), err.message)
    process.exit(1)
  }
}

// Main function to generate files
const main = () => {
  const spinner = logStep('Parsing Swagger Spec')
  const apiJson = loadApiYaml()
  spinner.succeed(chalk.green('Successfully parsed Swagger Spec'))

  // Web, Desktop & Native
  const spinner2 = logStep('Generating files')
  const generatedTypes = generateTypes(apiJson)
  const generatedApiClient = generateApiClient(apiJson)
  const generatedQueries = generateQueries(apiJson)
  const outputQueriesFile = 'queries.ts'
  spinner2.succeed(chalk.green('Generated files'))

  // Web
  const spinner3 = logStep('Writing files to Web App')
  fs.mkdirSync(webApiDir, { recursive: true })
  fs.writeFileSync(path.join(webApiDir, outputTypesFile), generatedTypes, 'utf8')
  fs.writeFileSync(path.join(webApiDir, outputBSDFile), generatedApiClient, 'utf8')
  fs.writeFileSync(path.join(webApiDir, outputQueriesFile), generatedQueries, 'utf8')
  const webRequestFilePath = path.join(webApiDir, 'request.ts')
  fs.copyFileSync(webDesktopRequestFilePath, webRequestFilePath)
  spinner3.succeed(chalk.green(`Copied files into ${webApiDir}`))

  // Desktop
  const spinner6 = logStep('Writing files to Desktop App')
  fs.mkdirSync(nativeApiDir, { recursive: true })
  fs.writeFileSync(path.join(nativeApiDir, outputTypesFile), generatedTypes, 'utf8')
  fs.writeFileSync(path.join(nativeApiDir, outputBSDFile), generatedApiClient, 'utf8')
  fs.writeFileSync(path.join(nativeApiDir, outputQueriesFile), generatedQueries, 'utf8')

  // Update request.ts for Desktop
  const desktopRequestContent = fs.readFileSync(webRequestFilePath, 'utf8')
  const updatedDesktopRequestContent = desktopRequestContent.replace("const BASE_URL = ''", `const BASE_URL = '${origin}'`)
  const desktopRequestFilePath = path.join(nativeApiDir, 'request.ts')
  fs.writeFileSync(desktopRequestFilePath, updatedDesktopRequestContent, 'utf8')
  spinner6.succeed(chalk.green(`Copied & Configured files into ${desktopApiDir}`))

  // Native
  const spinner4 = logStep('Writing files to Native App')
  fs.mkdirSync(nativeApiDir, { recursive: true })
  fs.writeFileSync(path.join(nativeApiDir, outputTypesFile), generatedTypes, 'utf8')
  fs.writeFileSync(path.join(nativeApiDir, outputBSDFile), generatedApiClient, 'utf8')
  fs.writeFileSync(path.join(nativeApiDir, outputQueriesFile), generatedQueries, 'utf8')

  // Update request.ts for Native
  const nativeRequestContent = fs.readFileSync(nativeRequestFilePath, 'utf8')
  const updatedRequestContent = nativeRequestContent
    .replace("const BASE_URL = ''", `const BASE_URL = '${origin}'`)
    .replace("// @ts-expect-error - don't need module in this file", '')
  const newNativeRequestFilePath = path.join(nativeApiDir, 'request.ts')
  fs.writeFileSync(newNativeRequestFilePath, updatedRequestContent, 'utf8')
  spinner4.succeed(chalk.green(`Copied & Configured files into ${nativeApiDir}`))

  // Go
  const spinner5 = logStep('Generating Go structs')
  const generatedGoStructs = generateGoStructs(apiJson)
  const goOutputDir = path.resolve(__dirname, goApiDir)
  fs.mkdirSync(goOutputDir, { recursive: true })
  const goOutputFile = path.join(goOutputDir, 'types.go')
  fs.writeFileSync(goOutputFile, generatedGoStructs, 'utf8')
  spinner5.succeed(chalk.green(`Generated Go structs in ${goApiDir.replace('.', '') + '/types.go'}`))

  log(chalk.green('\nDone!\n'))
}

main()
