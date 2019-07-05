const { Component } = require('@serverless/core')
const {
  getTemplate,
  resolveTemplate,
  getAllComponents,
  downloadComponents,
  setDependencies,
  createGraph,
  executeGraph,
  syncState,
  getOutputs
} = require('./utils')

class Template extends Component {
  async default(inputs = {}) {
    this.context.status('Deploying')

    const template = await getTemplate(inputs)

    this.context.debug(`Resovling the template's static variables.`)

    const resolvedTemplate = resolveTemplate(template)

    this.context.debug('Collecting components from the template.')

    const allComponents = getAllComponents(resolvedTemplate)

    this.context.debug('Downloading any NPM components found in the template.')

    const allComponentsDownloaded = await downloadComponents(allComponents)

    this.context.debug(`Analyzing the template's components dependencies.`)

    const allComponentsWithDependencies = setDependencies(allComponentsDownloaded)

    this.context.debug(`Creating the template's components graph.`)

    const graph = createGraph(allComponentsWithDependencies)

    this.context.debug('Executing template graph.')

    const allComponentsWithOutputs = await executeGraph(allComponentsWithDependencies, graph, this)

    this.context.debug('Syncing template state.')

    await syncState(allComponentsWithOutputs, this)

    const outputs = getOutputs(allComponentsWithOutputs)

    return outputs
  }

  async remove() {
    this.context.status('Removing')

    this.context.debug('Flushing template state and removing all components.')
    await syncState({}, this)

    return {}
  }
}

module.exports = Template
