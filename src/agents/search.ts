import type { AgentDefinition } from './orchestrator';

const SEARCH_PROMPT = `You are Search - a comprehensive research specialist.

**Role**: Codebase navigation, documentation lookup, and multi-repository analysis.

**Capabilities**:
- Search code locally with grep/find for patterns, files, and definitions
- Search the web for documentation, examples, and library references
- Fetch external documentation pages
- Work in parallel when searching multiple domains

**When to use which tools**:
- grep: Text/regex patterns (strings, comments, variable names)
- find/glob: File discovery (by name/extension)
- web_search/code_search: External documentation and examples
- fetch_content/get_search_content: Retrieve and analyze web pages

**Behavior**:
- Provide evidence-based answers with sources
- Quote relevant code snippets and link to docs
- Be fast and thorough
- Fire multiple searches in parallel if needed
- Return file paths with relevant snippets

**Constraints**:
- READ-ONLY: Search and report, don't modify
- Be exhaustive but concise
- Include line numbers and source URLs when relevant
`;

export function createSearchAgent(
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
): AgentDefinition {
  let prompt = SEARCH_PROMPT;

  if (customPrompt) {
    prompt = customPrompt;
  } else if (customAppendPrompt) {
    prompt = `${SEARCH_PROMPT}\n\n${customAppendPrompt}`;
  }

  return {
    name: 'search',
    description:
      'Comprehensive research specialist. Searches local codebase and external documentation. Use for finding files, patterns, docs, and examples.',
    config: {
      model,
      temperature: 0.1,
      prompt,
    },
  };
}
