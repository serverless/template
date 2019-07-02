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

    this.context.debug('getting template')

    const template = await getTemplate(inputs)

    this.context.debug('resolving template')

    const resolvedTemplate = resolveTemplate(template)

    this.context.debug('getting components')

    const allComponents = getAllComponents(resolvedTemplate)

    this.context.debug('downloading components')

    const allComponentsDownloaded = await downloadComponents(allComponents)

    this.context.debug('setting dependencies')

    const allComponentsWithDependencies = setDependencies(allComponentsDownloaded)

    this.context.debug('creating graph')

    const graph = createGraph(allComponentsWithDependencies)

    this.context.debug('executing graph')

    const allComponentsWithOutputs = await executeGraph(allComponentsWithDependencies, graph, this)

    this.context.debug('syncing state')

    await syncState(allComponentsWithOutputs, this)

    const outputs = getOutputs(allComponentsWithOutputs)

    return outputs
  }

  async remove() {
    this.context.status('Removing')

    await syncState({}, this)

    return {}
  }
}

module.exports = Template
