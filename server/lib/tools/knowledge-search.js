/**
 * Tool: knowledge-search
 * Retrieves relevant passages from this tenant's knowledge base (RAG) so agents
 * can ground their answers with citations. Generated for ScopeCash AI.
 */
const rag = require('../rag/ingest');

module.exports = {
  name: 'knowledge-search',
  description: 'Search the knowledge base for passages relevant to a query. Returns matched excerpts with citations.',
  inputs: ['query'],
  outputs: ['matches', 'citations'],

  /**
   * @param {object} input { query, topK? }
   * @param {object} ctx   { userId, orgId, modelId }
   */
  async run(input, ctx) {
    const query = typeof input === 'string' ? input : (input && input.query);
    if (!query) return { error: 'query required' };
    const namespace = (ctx && ctx.orgId) || 'default';
    const { matches, citations } = await rag.retrieve(namespace, query, input && input.topK);
    return { matches, citations };
  },
};

