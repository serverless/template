const { basename } = require('path')
const { pick, isEmpty, path, assocPath } = require('ramda')
const { Graph, alg } = require('graphlib')
const traverse = require('traverse')
const { utils } = require('@serverless/core')

const getOutputs = (allComponents) => {
  const outputs = {}

  for (const alias in allComponents) {
    outputs[alias] = allComponents[alias].outputs
  }

  return outputs
}

const resolveObject = (object, context) => {
  const regex = /\${(\w*:?[\w\d.-]+)}/g

  const resolvedObject = traverse(object).reduce(function(accum, value) {
    const matches = typeof value === 'string' ? value.match(regex) : null
    let newValue = value
    if (matches) {
      for (const match of matches) {
        const referencedPropertyPath = match.substring(2, match.length - 1).split('.')
        const referencedPropertyValue = path(referencedPropertyPath, context)

        if (referencedPropertyValue === undefined) {
          throw Error(`invalid reference ${match}`)
        }

        if (match === value) {
          newValue = referencedPropertyValue
        } else if (typeof referencedPropertyValue === 'string') {
          newValue = newValue.replace(match, referencedPropertyValue)
        } else {
          throw Error(`the referenced substring is not a string`)
        }
      }
    }
    accum = assocPath(this.path, newValue, accum)
    return accum
  }, {})

  return resolvedObject
}

const validateGraph = (graph) => {
  const isAcyclic = alg.isAcyclic(graph)
  if (!isAcyclic) {
    const cycles = alg.findCycles(graph)
    let msg = ['Your template has circular dependencies:']
    cycles.forEach((cycle, index) => {
      let fromAToB = cycle.join(' --> ')
      fromAToB = `${(index += 1)}. ${fromAToB}`
      const fromBToA = cycle.reverse().join(' <-- ')
      const padLength = fromAToB.length + 4
      msg.push(fromAToB.padStart(padLength))
      msg.push(fromBToA.padStart(padLength))
    }, cycles)
    msg = msg.join('\n')
    throw new Error(msg)
  }
}

const getTemplate = async (inputs) => {
  const template = inputs.template || {}

  if (typeof template === 'string') {
    if (
      !utils.isJsonPath(template) ||
      !utils.isYamlPath(template) ||
      !(await utils.fileExists(template))
    ) {
      throw Error('the referenced template path does not exist')
    }

    return utils.readFile(template)
  } else if (typeof template !== 'object') {
    throw Error('the template input could either be an object, or a string path to a template file')
  }
  return template
}

const resolveTemplate = (template) => {
  const regex = /\${(\w*:?[\w\d.-]+)}/g
  let variableResolved = false
  const resolvedTemplate = traverse(template).reduce(function(accum, value) {
    const matches = typeof value === 'string' ? value.match(regex) : null
    let newValue = value
    if (matches) {
      for (const match of matches) {
        const referencedPropertyPath = match.substring(2, match.length - 1).split('.')
        const referencedTopLevelProperty = referencedPropertyPath[0]

        if (!template[referencedTopLevelProperty]) {
          throw Error(`invalid reference ${match}`)
        }

        if (!template[referencedTopLevelProperty].component) {
          variableResolved = true
          const referencedPropertyValue = path(referencedPropertyPath, template)

          if (referencedPropertyValue === undefined) {
            throw Error(`invalid reference ${match}`)
          }

          if (match === value) {
            newValue = referencedPropertyValue
          } else if (typeof referencedPropertyValue === 'string') {
            newValue = newValue.replace(match, referencedPropertyValue)
          } else {
            throw Error(`the referenced substring is not a string`)
          }
        }
      }
    }
    accum = assocPath(this.path, newValue, accum)

    return accum
  }, {})
  if (variableResolved) {
    return resolveTemplate(resolvedTemplate)
  }
  return resolvedTemplate
}

const getAllComponents = (obj = {}) => {
  const allComponents = {}

  for (const key in obj) {
    if (obj[key].component) {
      allComponents[key] = {
        path: obj[key].component,
        inputs: obj[key].inputs || {}
      }
    }
  }

  return allComponents
}

const downloadComponents = async (allComponents) => {
  const aliasesToDownload = Object.keys(allComponents).filter(
    (alias) => allComponents[alias].path !== basename(allComponents[alias].path)
  )
  const componentsToDownload = pick(aliasesToDownload, allComponents)

  const componentsList = aliasesToDownload.map((alias) => componentsToDownload[alias].path)

  const componentsPaths = await utils.download(componentsList)

  const downloadedComponents = {}
  for (const alias in componentsToDownload) {
    const npmPackageName = componentsToDownload[alias].path
    downloadedComponents[alias] = {
      ...componentsToDownload[alias],
      path: componentsPaths[npmPackageName]
    }
  }

  allComponents = { ...allComponents, ...downloadedComponents }

  return allComponents
}

const setDependencies = (allComponents) => {
  const regex = /\${(\w*:?[\w\d.-]+)}/g

  for (const alias in allComponents) {
    const dependencies = traverse(allComponents[alias].inputs).reduce(function(accum, value) {
      const matches = typeof value === 'string' ? value.match(regex) : null
      if (matches) {
        for (const match of matches) {
          const referencedComponent = match.substring(2, match.length - 1).split('.')[0]

          if (!allComponents[referencedComponent]) {
            throw Error(`the referenced component in expression ${match} does not exist`)
          }

          if (!accum.includes(referencedComponent)) {
            accum.push(referencedComponent)
          }
        }
      }
      return accum
    }, [])

    allComponents[alias].dependencies = dependencies
  }

  return allComponents
}

const createGraph = (allComponents) => {
  const graph = new Graph()

  for (const alias in allComponents) {
    graph.setNode(alias, allComponents[alias])
  }

  for (const alias in allComponents) {
    const { dependencies } = allComponents[alias]
    if (!isEmpty(dependencies)) {
      for (const dependency of dependencies) {
        graph.setEdge(alias, dependency)
      }
    }
  }

  validateGraph(graph)

  return graph
}

const executeGraph = async (allComponents, graph, instance) => {
  const leaves = graph.sinks()

  if (isEmpty(leaves)) {
    return allComponents
  }

  const promises = []

  for (const alias of leaves) {
    const componentData = graph.node(alias)

    const fn = async () => {
      const component = await instance.load(componentData.path, alias)
      const availableOutputs = getOutputs(allComponents)
      const inputs = resolveObject(allComponents[alias].inputs, availableOutputs)
      instance.context.status('Deploying', alias)
      allComponents[alias].outputs = (await component(inputs)) || {}
    }

    promises.push(fn())
  }

  await Promise.all(promises)

  for (const alias of leaves) {
    graph.removeNode(alias)
  }

  return executeGraph(allComponents, graph, instance)
}

const syncState = async (allComponents, instance) => {
  const promises = []

  for (const alias in instance.state.components || {}) {
    if (!allComponents[alias]) {
      const fn = async () => {
        const component = await instance.load(instance.state.components[alias], alias)
        instance.context.status('Removing', alias)
        await component.remove()
      }

      promises.push(fn())
    }
  }

  await Promise.all(promises)

  instance.state.components = {}

  for (const alias in allComponents) {
    instance.state.components[alias] = allComponents[alias].path
  }

  await instance.save()
}

module.exports = {
  getTemplate,
  resolveTemplate,
  getAllComponents,
  downloadComponents,
  setDependencies,
  createGraph,
  executeGraph,
  syncState,
  getOutputs
}
