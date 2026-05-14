import { describe, expect, mock, test } from 'bun:test';


mock.module('typebox', () => ({
  Type: {
    String: (options?: any) => ({ type: 'string', ...options }),
    Number: (options?: any) => ({ type: 'number', ...options }),
    Integer: (options?: any) => ({ type: 'integer', ...options }),
    Boolean: (options?: any) => ({ type: 'boolean', ...options }),
    Array: (schema: any, options?: any) => ({ type: 'array', items: schema, ...options }),
    Object: (properties: any, options?: any) => ({ type: 'object', properties, ...options }),
    Optional: (schema: any) => ({ ...schema, optional: true }),
    Union: (schemas: any[]) => ({ anyOf: schemas }),
    Literal: (value: any) => ({ const: value }),
    Record: (key: any, value: any) => ({ type: 'record', key, value }),
  },
}));

mock.module('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: mock(async () => ({
    session: {
      prompt: mock(async () => {}),
      state: { messages: [] },
      subscribe: mock(() => () => {}),
      dispose: mock(() => {}),
      abort: mock(async () => {}),
      isStreaming: false,
    },
  })),
  getAgentDir: () => '/tmp/omo-pi-test/agent',
  SessionManager: {
    inMemory: () => ({ getBranch: () => [], getEntries: () => [], getLeafId: () => undefined, getSessionFile: () => undefined }),
  },
}));

describe('Pi adapter config helpers', () => {
  test('strips JSON comments without breaking URLs inside strings', async () => {
    const { stripJsonCommentsSafely } = await import('./pi');

    const raw = `{
  "$schema": "https://unpkg.com/oh-my-opencode-slim@latest/schema.json", // trailing comment
  /* block comment */
  "council": {
    "meeting_backend": "collaborating"
  }
}`;

    const cleaned = stripJsonCommentsSafely(raw);
    const parsed = JSON.parse(cleaned);

    expect(parsed.$schema).toBe('https://unpkg.com/oh-my-opencode-slim@latest/schema.json');
    expect(parsed.council.meeting_backend).toBe('collaborating');
    expect(cleaned).not.toContain('trailing comment');
    expect(cleaned).not.toContain('block comment');
  });
});

describe('Pi adapter council helpers', () => {
  test('resolves explicit participants with fallback names and agents', async () => {
    const { resolvePiCouncilParticipants } = await import('./pi');

    const result = resolvePiCouncilParticipants({
      config: null,
      participants: [
        { name: 'architect', model: 'openai/gpt-4o' },
        { agent: 'oracle', prompt: 'Review risks' },
        { model: 'google/gemini-pro' },
      ],
    });

    expect(result.error).toBeUndefined();
    expect(result.participants).toEqual([
      { name: 'architect', agent: 'architect', model: 'openai/gpt-4o', variant: undefined, prompt: undefined },
      { name: 'oracle', agent: 'oracle', model: undefined, variant: undefined, prompt: 'Review risks' },
      { name: 'participant-3', agent: 'participant-3', model: 'google/gemini-pro', variant: undefined, prompt: undefined },
    ]);
  });

  test('resolves configured preset participants and skips legacy master', async () => {
    const { resolvePiCouncilParticipants } = await import('./pi');

    const result = resolvePiCouncilParticipants({
      config: {
        council: {
          default_preset: 'design',
          presets: {
            design: {
              alpha: { agent: 'oracle', model: 'openai/gpt-4o', prompt: 'Architecture review' },
              beta: { agent: 'fixer' },
              master: { model: 'openai/ignored' },
            },
          },
        },
      } as any,
    });

    expect(result.error).toBeUndefined();
    expect(result.participants.map((p: any) => p.name)).toEqual(['alpha', 'beta']);
    expect(result.participants[0]).toMatchObject({ name: 'alpha', agent: 'oracle', model: 'openai/gpt-4o' });
  });

  test('reports missing council configuration with actionable message', async () => {
    const { resolvePiCouncilParticipants } = await import('./pi');

    const result = resolvePiCouncilParticipants({ config: null });

    expect(result.participants).toEqual([]);
    expect(result.error).toContain('Council is not configured');
  });

  test('formats isolated council results preserving failures and completion count', async () => {
    const { formatPiCouncilResults } = await import('./pi');

    const output = formatPiCouncilResults('Choose an architecture', [
      { name: 'alpha', agent: 'oracle', model: 'openai/gpt-4o', status: 'completed', result: 'Use A' },
      { name: 'beta', agent: 'fixer', status: 'failed', error: 'Provider unavailable' },
    ]);

    expect(output).toContain('## Isolated Council Results');
    expect(output).toContain('Completed: 1/2');
    expect(output).toContain('### alpha (openai/gpt-4o)');
    expect(output).toContain('Use A');
    expect(output).toContain('### beta');
    expect(output).toContain('Provider unavailable');
    expect(output).toContain('Preserve disagreements');
  });
});

describe('Pi adapter meeting helpers', () => {
  test('normalizes meeting objective with decision fallback', async () => {
    const { normalizePiMeetingObjective } = await import('./pi');

    expect(normalizePiMeetingObjective(undefined)).toBe('decision');
    expect(normalizePiMeetingObjective('review')).toBe('review');
    expect(normalizePiMeetingObjective('not-real')).toBe('decision');
  });

  test('normalizes meeting max rounds into supported range', async () => {
    const { normalizePiMeetingMaxRounds } = await import('./pi');

    expect(normalizePiMeetingMaxRounds(undefined)).toBe(2);
    expect(normalizePiMeetingMaxRounds(0)).toBe(0);
    expect(normalizePiMeetingMaxRounds(3.8)).toBe(3);
    expect(normalizePiMeetingMaxRounds(99)).toBe(5);
  });

  test('normalizes meeting backend with session fallback', async () => {
    const { normalizePiMeetingBackend } = await import('./pi');

    expect(normalizePiMeetingBackend(undefined)).toBe('session');
    expect(normalizePiMeetingBackend('session')).toBe('session');
    expect(normalizePiMeetingBackend('collaborating')).toBe('collaborating');
    expect(normalizePiMeetingBackend('internal-store')).toBe('session');
  });

  test('resolves meeting backend selection before runtime fallback', async () => {
    const { resolvePiMeetingBackend } = await import('./pi-meeting');

    const sessionResolution = resolvePiMeetingBackend(undefined);
    expect(sessionResolution.requestedBackend).toBe('session');
    expect(sessionResolution.backendUsed).toBe('session');
    expect(sessionResolution.fallbackReason).toBeUndefined();

    const collaboratingResolution = resolvePiMeetingBackend('collaborating');
    expect(collaboratingResolution.requestedBackend).toBe('collaborating');
    expect(collaboratingResolution.backendUsed).toBe('collaborating');
    expect(collaboratingResolution.fallbackReason).toBeUndefined();
  });

  test('resolves collaborating package root from known install locations', async () => {
    const { resolveCollaboratingPackageRoot } = await import('./pi-meeting');

    const root = resolveCollaboratingPackageRoot();
    expect(root.includes('pi-collaborating-agents')).toBe(true);
  });

  test('builds collaborating spawn options without child session-control', async () => {
    const { createCollaboratingSpawnOptions } = await import('./pi-meeting');

    const onLaunch = () => {};
    const options = createCollaboratingSpawnOptions({
      meetingId: 'omo-meet-smoke',
      phase: 'discussion',
      round: 1,
      index: 2,
      chairName: 'omo-collab-chair-omo-meet-smoke',
      collabConfig: {
        subagentLaunchMode: 'process',
        closeCompletedCmuxPanes: true,
      } as any,
      onLaunch,
    });

    expect(options).toMatchObject({
      runId: 'omo-meet-smoke-discussion-1',
      parentAgentName: 'omo-collab-chair-omo-meet-smoke',
      enableSessionControl: false,
      launchMode: 'process',
      closeCompletedCmuxPane: true,
      launchDelayMs: 300,
    });
    expect(options.onLaunch).toBe(onLaunch);
  });

  test('formats completed collaborating backend metadata from live-smoke path', async () => {
    const { formatPiMeetingResult } = await import('./pi');

    const output = formatPiMeetingResult({
      meetingId: 'omo-meet-smoke',
      question: 'Can collaborating meeting participants reply?',
      objective: 'debug',
      status: 'completed',
      roundsCompleted: 1,
      participants: [
        { name: 'oracle', agent: 'oracle', status: 'completed', finalPosition: 'Participant replied.' },
        { name: 'fixer', agent: 'fixer', status: 'completed', finalPosition: 'Participant replied.' },
      ],
      report: '## Realtime Meeting Result\n\n### Status\ncompleted',
      keySignals: ['Participants returned responses via agent_message.'],
      requestedBackend: 'collaborating',
      backendUsed: 'collaborating',
    });

    expect(output).toContain('requestedBackend: collaborating');
    expect(output).toContain('backendUsed: collaborating');
    expect(output).toContain('transcript omitted: yes');
    expect(output).not.toContain('fallbackReason:');
  });

  test('formats meeting result without leaking transcript by default', async () => {
    const { formatPiMeetingResult } = await import('./pi');

    const output = formatPiMeetingResult({
      meetingId: 'test-meeting-1',
      question: 'Pick an approach',
      objective: 'decision',
      status: 'completed',
      roundsCompleted: 2,
      participants: [
        { name: 'oracle', agent: 'oracle', status: 'completed', finalPosition: 'Use A' },
      ],
      report: '## Realtime Meeting Result\n\n### Question\nPick an approach\n\n### Key Signals From Discussion\n- Oracle changed view after implementation risk was clarified.',
      keySignals: ['Oracle changed view after implementation risk was clarified.'],
      requestedBackend: 'session',
      backendUsed: 'session',
    });

    expect(output).toContain('## Realtime Meeting Result');
    expect(output).toContain('Key Signals From Discussion');
    expect(output).toContain('requestedBackend: session');
    expect(output).toContain('backendUsed: session');
    expect(output).toContain('transcript omitted: yes');
    expect(output).not.toContain('raw hidden noise');
  });

  test('formats meeting transcript only when explicitly present', async () => {
    const { formatPiMeetingResult } = await import('./pi');

    const output = formatPiMeetingResult({
      meetingId: 'test-meeting-2',
      question: 'Pick an approach',
      objective: 'review',
      status: 'completed',
      roundsCompleted: 1,
      participants: [
        { name: 'fixer', agent: 'fixer', status: 'completed', finalPosition: 'Use B' },
      ],
      report: '## Realtime Meeting Result\n\n### Key Signals From Discussion\n- Fixer found lower-risk implementation.',
      keySignals: ['Fixer found lower-risk implementation.'],
      requestedBackend: 'collaborating',
      backendUsed: 'session',
      fallbackReason: 'spawn failed, fell back to session backend',
      transcript: [
        {
          id: 'm1',
          meetingId: 'test-meeting-2',
          round: 0,
          phase: 'opening',
          from: 'fixer',
          role: 'fixer',
          content: 'raw hidden noise',
          timestamp: 1,
        },
      ],
    });

    expect(output).toContain('## Transcript Appendix');
    expect(output).toContain('includeTranscript=true');
    expect(output).toContain('requestedBackend: collaborating');
    expect(output).toContain('backendUsed: session');
    expect(output).toContain('fallbackReason: spawn failed, fell back to session backend');
    expect(output).toContain('raw hidden noise');
  });

  test('formats failed participant errors into final report output', async () => {
    const { formatPiMeetingResult } = await import('./pi');

    const output = formatPiMeetingResult({
      meetingId: 'test-meeting-3',
      question: 'Pick an approach',
      objective: 'decision',
      status: 'failed',
      roundsCompleted: 1,
      participants: [
        { name: 'oracle', agent: 'oracle', status: 'failed', error: 'agent_message send failed' },
        { name: 'fixer', agent: 'fixer', status: 'failed', error: 'subagent exited before sending response' },
      ],
      report: '## Realtime Meeting Result\n\n### Participants\n- oracle (oracle, failed) — agent_message send failed\n- fixer (fixer, failed) — subagent exited before sending response',
      keySignals: ['No discussion content was available.'],
      requestedBackend: 'collaborating',
      backendUsed: 'collaborating',
    });

    expect(output).toContain('agent_message send failed');
    expect(output).toContain('subagent exited before sending response');
  });
});

describe('Pi adapter preset helpers', () => {
  test('parses provider/model IDs', async () => {
    const { parsePiModelId } = await import('./pi');

    expect(parsePiModelId('openai/gpt-4o')).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(parsePiModelId('dmxapi/gpt-5.5')).toEqual({ provider: 'dmxapi', model: 'gpt-5.5' });
    expect(parsePiModelId('missing-slash')).toBeUndefined();
    expect(parsePiModelId('/missing-provider')).toBeUndefined();
    expect(parsePiModelId('missing-model/')).toBeUndefined();
  });

  test('resolves preset switch plan with orchestrator model and thinking', async () => {
    const { resolvePresetSwitchPlan } = await import('./pi');

    const plan = resolvePresetSwitchPlan({
      presets: {
        powerful: {
          orchestrator: { model: 'openai/gpt-4o', thinking: 'high' },
          explorer: { model: 'openai/gpt-4o-mini' },
        },
      },
    } as any, 'powerful');

    expect(plan).toEqual({ model: 'openai/gpt-4o', thinking: 'high' });
  });

  test('reports missing preset with available names', async () => {
    const { resolvePresetSwitchPlan } = await import('./pi');

    const plan = resolvePresetSwitchPlan({ presets: { cheap: {} } } as any, 'powerful');

    expect(plan.error).toContain('Preset "powerful" not found');
    expect(plan.error).toContain('cheap');
  });
});
