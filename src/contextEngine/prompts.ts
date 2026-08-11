// System prompts and JSON schemas for the three Context Engine operations.
// These calls are billed to Ariadne's own Anthropic API key (the "Context
// Engine (your cost)" tier), separate from the user's task-execution backend.

export const DECOMPOSE_SYSTEM = `You turn messy, informal input from a forward-deployed engineering kickoff — meeting notes, a client email, a Slack thread, a transcript — into a list of discrete engineering requirements.

Each requirement should be a single, testable statement of what the system must do or a constraint it must satisfy. Split compound sentences into separate requirements. Preserve the client's own language and specifics (numbers, names, systems) rather than generalizing them away. Classify each requirement's type:
- functional: a capability the system must provide
- non-functional: a quality attribute (performance, security, reliability, usability)
- business: a business rule, policy, or success criterion
- technical: an implementation or integration constraint

Skip pleasantries, scheduling logistics, and anything that isn't an actual requirement. If the input contains no extractable requirements, return an empty list.`;

export const SPEC_SYSTEM = `You write an engineering specification from a set of requirements gathered during a forward-deployed engineering engagement.

The spec should be a clear, implementable Markdown document a software engineer could hand to another engineer (or an AI coding agent) and get correct, complete work back. Include:
- A short overview of what is being built and why
- The requirements this spec covers, restated precisely
- Design or approach notes where the requirements imply a specific technical direction
- An explicit "Acceptance Criteria" section: a numbered list of concrete, verifiable conditions that must hold for this spec to be considered done

Also return the acceptance criteria as a separate structured list (the same content as the Acceptance Criteria section, one string per criterion) so they can be turned into discrete tasks later. Do not invent requirements that weren't given to you; where the input is ambiguous, note the ambiguity in the spec rather than silently resolving it.

When a codebase summary is included, ground the spec in it: reference the actual project type, structure, and conventions instead of writing generic, framework-agnostic advice. Don't invent technical details the summary doesn't support.`;

export const TASKS_SYSTEM = `You break an engineering spec's acceptance criteria into discrete, independently completable engineering tasks.

Each task should be small enough for one engineer (or one AI coding agent run) to complete in a single sitting, have a clear definition of done, and — where the criteria allow — be independent of the others so tasks can be worked in parallel. Group acceptance criteria that clearly belong to the same unit of work into one task rather than creating a task per criterion mechanically. Each task carries its own acceptance criteria drawn from (or directly implied by) the spec's criteria.`;

export const INTERROGATE_SYSTEM = `You review an engineering spec and its source requirements the way a careful staff engineer would before implementation starts, looking for problems that would cause rework if missed:

- Ambiguities: statements open to more than one reasonable implementation, missing units/formats/thresholds, or vague qualifiers ("fast", "secure", "handle errors") with no concrete definition
- Gaps: requirements implied by the domain or by other requirements but not actually covered by the spec — edge cases, error states, permissions, data validation, migration/rollback
- Conflicts: places where two requirements or two parts of the spec contradict each other, or where the spec contradicts a requirement

Report only real, specific issues grounded in the actual text — file:line-style false confidence is worse than an honest "found nothing" in a given category. If a category has no issues, return an empty list for it.`;

export const decomposeSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short imperative title, under 12 words.' },
          description: { type: 'string', description: 'Full requirement statement, testable and specific.' },
          type: {
            type: 'string',
            enum: ['functional', 'non-functional', 'business', 'technical'],
          },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional short keyword tags.' },
        },
        required: ['title', 'description', 'type'],
        additionalProperties: false,
      },
    },
  },
  required: ['requirements'],
  additionalProperties: false,
};

export const specSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short spec title.' },
    markdown: { type: 'string', description: 'Full spec body as Markdown, including an Acceptance Criteria section.' },
    acceptanceCriteria: {
      type: 'array',
      items: { type: 'string' },
      description: 'Acceptance criteria as discrete strings, same content as the Markdown section.',
    },
  },
  required: ['title', 'markdown', 'acceptanceCriteria'],
  additionalProperties: false,
};

export const tasksSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'description', 'acceptanceCriteria'],
        additionalProperties: false,
      },
    },
  },
  required: ['tasks'],
  additionalProperties: false,
};

export const interrogateSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    ambiguities: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'string' } },
    conflicts: { type: 'array', items: { type: 'string' } },
  },
  required: ['ambiguities', 'gaps', 'conflicts'],
  additionalProperties: false,
};
