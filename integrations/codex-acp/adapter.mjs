const invalid = message => Object.assign(new Error(message), { code: -32602 });
const textContent = text => ({ type: 'content', content: { type: 'text', text } });

export class CodexAdapter {
  constructor(client, server, { interruptTimeout = 30000 } = {}) {
    this.client = client; this.server = server; this.sessions = new Map(); this.initialized = false;
    this.loading = new Set(); this.handling = new Set(); this.interruptTimeout = interruptTimeout;
    client.on('message', m => {
      const task = Promise.resolve().then(() => this.handle(m)); this.handling.add(task);
      task.then(() => this.handling.delete(task), () => this.handling.delete(task));
    });
    server.on('message', m => this.fromCodex(m));
    server.on('close', () => {
      for (const s of this.sessions.values()) if (s.active) this.finish(s.active, new Error('Codex process disconnected'));
    });
  }
  async drain() { await Promise.allSettled([...this.handling]); }
  finish(active, error, result) {
    if (active.terminal) return;
    active.terminal = true; clearTimeout(active.interruptTimer);
    if (error) active.reject(error); else active.resolve(result);
  }
  async interrupt(sessionId, active) {
    active.cancel = true;
    if (active.terminal || !active.id) return;
    if (!active.interrupting) active.interrupting = (async () => {
      try {
        await this.server.request('turn/interrupt', { threadId: sessionId, turnId: active.id });
        if (!active.terminal) active.interruptTimer = setTimeout(() => {
          this.server.close(new Error('Codex interrupt did not complete'));
        }, this.interruptTimeout);
      } catch (e) { this.server.close(e); }
    })();
    await active.interrupting;
  }
  async pages(method, params) {
    const rows = []; const seen = new Set(); let cursor;
    do {
      const page = await this.server.request(method, { ...params, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page?.data)) throw new Error(`Invalid ${method} page`);
      rows.push(...page.data); cursor = page.nextCursor;
      if (cursor != null && (typeof cursor !== 'string' || !cursor || seen.has(cursor))) throw new Error(`Invalid ${method} cursor`);
      if (cursor) seen.add(cursor);
    } while (cursor);
    return rows;
  }
  async history(r) {
    let turns = r.thread.turns ?? [];
    const paginated = r.thread.historyMode === 'paginated' || r.turnsBackwardsCursor != null || r.itemsBackwardsCursor != null || turns.some(t => t.itemsView && t.itemsView !== 'full');
    if (paginated) {
      // Re-read from the beginning in ascending order. Resume's backwards cursors
      // mark partial history, not the start of the full conversation.
      turns = await this.pages('thread/turns/list', { threadId: r.thread.id, sortDirection: 'asc', itemsView: 'full' });
      turns = [...new Map(turns.map(t => [t.id, t])).values()];
      if ((r.thread.turns ?? []).some(t => !turns.some(full => full.id === t.id))) throw new Error('Incomplete thread history');
      for (const turn of turns) {
        const entries = await this.pages('thread/items/list', { threadId: r.thread.id, turnId: turn.id, sortDirection: 'asc' });
        if (entries.some(e => e.turnId !== turn.id || !e.item?.id)) throw new Error('Invalid thread item history');
        if ((turn.items ?? []).some(item => !entries.some(e => e.item.id === item.id))) throw new Error('Incomplete thread item history');
        turn.items = entries.map(e => e.item);
      }
    }
    const items = new Map();
    for (const turn of turns) for (const item of turn.items ?? []) {
      items.set(item.id, { item, completed: turn.status !== 'inProgress' });
    }
    return [...items.values()];
  }
  async openSession(method, p) {
    const load = method === 'session/load';
    if (typeof p.cwd !== 'string' || !p.cwd) throw invalid('cwd required');
    if (p.mcpServers?.length) throw invalid('Inline MCP servers unsupported; configure MCP in Codex');
    if (load && (typeof p.sessionId !== 'string' || !p.sessionId)) throw invalid('sessionId required');
    let id = load ? p.sessionId : null; let locked = false;
    if (load) {
      if (this.loading.has(id)) throw invalid('Session is loading');
      if (this.sessions.get(id)?.active) throw invalid('Cannot load an active session');
      this.loading.add(id); locked = true;
    }
    let requested = false; let mutated = false;
    try {
      await this.requireSubscription();
      const config = { cwd: p.cwd, modelProvider: 'openai', approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: 'workspace-write', config: { forced_login_method: 'chatgpt' } };
      requested = true;
      const r = await this.server.request(load ? 'thread/resume' : 'thread/start', { ...config, ...(load ? { threadId: id } : {}) });
      mutated = true;
      if (r.modelProvider !== 'openai' || r.approvalsReviewer !== 'user' || r.approvalPolicy !== 'untrusted' || r.sandbox?.type !== 'workspaceWrite') {
        this.server.close(new Error('Unsafe effective Codex session configuration'));
        throw new Error('Codex did not apply OpenAI, user approvals and workspace-write settings');
      }
      if (load && r.thread.id !== id) throw new Error('Codex resumed a different thread');
      if (!load) {
        id = r.thread.id;
        if (typeof id !== 'string' || !id || this.sessions.has(id) || this.loading.has(id)) throw new Error('Conflicting Codex thread ID');
        this.loading.add(id); locked = true;
      }
      const models = await this.models();
      const history = load ? await this.history(r) : [];
      const s = this.sessions.get(id) ?? {};
      Object.assign(s, { model: r.model, models, active: null, streamed: new Set(), output: new Map() });
      this.sessions.set(id, s);
      for (const { item, completed } of history) this.item(id, item, completed, true);
      return { ...(!load ? { sessionId: id } : {}), models: { currentModelId: r.model, availableModels: models.map(m => ({ modelId: m.model, name: m.displayName, description: m.description })) } };
    } catch (e) {
      // Once upstream was (or may have been) changed, an incomplete local
      // session must not be reused, even if its response was lost.
      if (mutated || (requested && !e.rpcResponse)) this.server.close(e);
      throw e;
    } finally { if (locked) this.loading.delete(id); }
  }
  update(sessionId, update) { this.client.notify('session/update', { sessionId, update }); }
  async handle(m) {
    try {
      const result = await this.dispatch(m.method, m.params ?? {});
      if (m.id !== undefined) this.client.reply(m.id, result);
    } catch (e) {
      if (m.id !== undefined && !this.client.closed) this.client.fail(m.id, e.code ?? -32603, e.message);
    }
  }
  async requireSubscription() {
    const { account } = await this.server.request('account/read', { refreshToken: false });
    if (account?.type !== 'chatgpt') throw Object.assign(new Error('ChatGPT login required. Run codex login; API-key and other providers are not allowed.'), { code: -32000 });
  }
  async models() {
    const models = []; let cursor;
    do {
      const page = await this.server.request('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) });
      models.push(...page.data); cursor = page.nextCursor;
    } while (cursor);
    return models;
  }
  session(id) { const s = this.sessions.get(id); if (!s) throw invalid('Unknown session'); return s; }
  async dispatch(method, p) {
    if (method === 'initialize') {
      if (this.initialized) throw invalid('Already initialized');
      if (p.protocolVersion !== 1) throw invalid('ACP protocol version 1 required');
      await this.server.request('initialize', { clientInfo: { name: 'grok_build_codex_acp', version: '0.1.0', title: 'Grok Build Codex adapter' } });
      this.server.notify('initialized', {}); this.initialized = true;
      return { protocolVersion: 1, agentInfo: { name: 'codex-subscription', version: '0.1.0', title: 'Codex (ChatGPT subscription)' }, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, mcpCapabilities: {} }, authMethods: [{ id: 'codex_chatgpt', name: 'ChatGPT subscription', description: 'Sign in with codex login before connecting.' }] };
    }
    if (!this.initialized) throw invalid('Initialize first');
    if (this.server.closed) throw new Error('Codex process disconnected');
    if (this.loading.has(p.sessionId) && method !== 'session/load') throw invalid('Session is loading');
    if (method === 'authenticate') {
      if (p.methodId !== 'codex_chatgpt') throw invalid('Unsupported authentication method');
      await this.requireSubscription(); return {};
    }
    if (method === 'session/new' || method === 'session/load') return this.openSession(method, p);
    if (method === 'session/set_model') {
      const s = this.session(p.sessionId);
      if (s.active) throw invalid('Cannot change model during a turn');
      if (!s.models.some(m => m.model === p.modelId)) throw invalid('Unknown model');
      s.model = p.modelId; return {};
    }
    if (method === 'session/prompt') {
      const s = this.session(p.sessionId);
      if (s.active) throw invalid('A prompt is already active');
      if (!Array.isArray(p.prompt) || !p.prompt.length) throw invalid('Prompt required');
      const input = p.prompt.map(b => {
        if (b.type === 'text' && typeof b.text === 'string') return { type: 'text', text: b.text };
        if (b.type === 'image' && typeof b.data === 'string' && /^image\/[\w.+-]+$/.test(b.mimeType)) return { type: 'image', url: `data:${b.mimeType};base64,${b.data}` };
        if (b.type === 'resource' && typeof b.resource?.text === 'string') return { type: 'text', text: `${b.resource.uri ?? ''}\n${b.resource.text}` };
        throw invalid(`Unsupported prompt block: ${b.type}`);
      });
      // Install before turn/start: notifications may precede its response.
      let resolve, reject;
      const done = new Promise((a, b) => { resolve = a; reject = b; });
      done.catch(() => {});
      const active = s.active = { resolve, reject, id: null, cancel: false, terminal: false, submitted: false };
      s.streamed.clear(); s.output = new Map();
      try {
        await this.requireSubscription();
        if (active.terminal) return await done;
        if (active.cancel) { this.finish(active, null, { stopReason: 'cancelled' }); return await done; }
        active.submitted = true;
        try {
          const r = await this.server.request('turn/start', { threadId: p.sessionId, input, model: s.model });
          if (typeof r?.turn?.id !== 'string' || (active.id && active.id !== r.turn.id)) throw new Error('Invalid Codex turn/start response');
          active.id = r.turn.id;
        } catch (e) {
          if (active.terminal) return await done;
          // A server rejection with no observed turn is definitive. A transport
          // timeout is not: keep the turn owned until terminal confirmation.
          if (!active.id && e.rpcResponse) throw e;
          active.cancel = true;
          if (active.id) await this.interrupt(p.sessionId, active);
          else this.server.close(new Error('Unknown outcome of Codex turn/start'));
          await done;
          throw e;
        }
        if (active.cancel) await this.interrupt(p.sessionId, active);
        return await done;
      } finally {
        active.terminal = true; clearTimeout(active.interruptTimer);
        if (s.active === active) s.active = null;
      }
    }
    if (method === 'session/cancel') {
      const s = this.session(p.sessionId);
      if (s.active) await this.interrupt(p.sessionId, s.active);
      return {};
    }
    throw Object.assign(new Error(`Unsupported method: ${method}`), { code: -32601 });
  }
  item(id, item, completed, replay = false) {
    const s = this.session(id);
    if (item.type === 'agentMessage') {
      if (completed && (replay || !s.streamed.has(item.id))) this.update(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: item.text } });
      return;
    }
    if (item.type === 'userMessage') {
      if (replay) for (const b of item.content) if (b.type === 'text') this.update(id, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: b.text } });
      return;
    }
    if (item.type === 'reasoning') {
      if (replay) for (const text of item.summary ?? []) this.update(id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });
      return;
    }
    const kind = item.type === 'commandExecution' ? 'execute' : item.type === 'fileChange' ? 'edit' : item.type === 'webSearch' ? 'search' : 'other';
    const title = item.command ?? item.tool ?? item.query ?? item.type;
    const content = [];
    if (item.type === 'commandExecution') {
      s.output ??= new Map();
      if (typeof item.aggregatedOutput === 'string') s.output.set(item.id, item.aggregatedOutput);
      if (s.output.has(item.id)) content.push(textContent(s.output.get(item.id)));
    } else if (item.aggregatedOutput) content.push(textContent(item.aggregatedOutput));
    if (item.type === 'fileChange') for (const c of item.changes ?? []) content.push(textContent(`${c.path}\n${c.diff ?? ''}`));
    if (item.type === 'plan' && item.text) content.push(textContent(item.text));
    if (replay) this.update(id, { sessionUpdate: 'tool_call', toolCallId: item.id, title, kind, status: 'in_progress' });
    this.update(id, { sessionUpdate: completed ? 'tool_call_update' : 'tool_call', toolCallId: item.id, title, kind, status: completed ? (['failed', 'declined'].includes(item.status) ? 'failed' : 'completed') : 'in_progress', ...(content.length ? { content } : {}), rawInput: item, ...(item.changes ? { locations: item.changes.map(c => ({ path: c.path })) } : {}) });
  }
  async fromCodex(m) {
    const p = m.params ?? {}; const s = this.sessions.get(p.threadId);
    try {
      if (m.id !== undefined) {
        if (m.method === 'item/tool/requestUserInput') {
          const active = s?.active;
          if (active?.submitted && !active.id) active.id = p.turnId;
          const current = () => active && s.active === active && !active.terminal && !active.cancel && active.id === p.turnId;
          if (!current()) return this.server.reply(m.id, { answers: {} });
          if (!Array.isArray(p.questions) || !p.questions.length || p.questions.some(q => q.isSecret || !Array.isArray(q.options) || !q.options.length)) {
            return this.server.fail(m.id, -32601, 'Secret or free-text-only questions are not supported by this client');
          }
          let response;
          try {
            response = await this.client.request('_cursor/ask_question', { sessionId: p.threadId, toolCallId: p.itemId, title: 'Codex needs input', questions: p.questions.map(q => ({ id: q.id, prompt: q.question, options: q.options.map((o, i) => ({ id: String(i), label: o.label })), allowMultiple: false })) }, 300000);
          } catch { /* Unsupported client or dismissed dialog: no fabricated answers. */ }
          const answers = {};
          if (current() && response?.outcome?.outcome === 'answered') {
            for (const answer of response.outcome.answers ?? []) {
              const q = p.questions.find(q => q.id === answer.questionId);
              const ids = answer.selectedOptionIds;
              if (!q || !Array.isArray(ids) || ids.length !== 1 || !/^\d+$/.test(ids[0]) || !q.options[Number(ids[0])]) continue;
              answers[q.id] = { answers: [q.options[Number(ids[0])].label] };
            }
          }
          if (!this.server.closed) this.server.reply(m.id, { answers });
          return;
        }
        if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(m.method)) {
          const permissions = m.method === 'item/permissions/requestApproval';
          const active = s?.active; const turnId = p.turnId;
          const deny = { permissions: {}, scope: 'turn' };
          if (active?.submitted && !active.id && typeof turnId === 'string') active.id = turnId;
          const current = () => active && s.active === active && !active.terminal && !active.cancel && typeof turnId === 'string' && active.id === turnId;
          if (!current()) return this.server.reply(m.id, permissions ? deny : { decision: 'cancel' });
          const requested = permissions ? structuredClone(p.permissions) : null;
          if (permissions && (!requested || typeof requested !== 'object' || Array.isArray(requested) || Object.keys(requested).some(k => !['fileSystem', 'network'].includes(k)))) {
            return this.server.reply(m.id, deny);
          }
          let r;
          try {
            r = await this.client.request('session/request_permission', { sessionId: p.threadId, toolCall: { toolCallId: p.itemId, title: p.command ?? p.reason ?? 'Approve Codex tool', status: 'pending', rawInput: p }, options: [{ optionId: 'accept', name: 'Allow once', kind: 'allow_once' }, { optionId: 'decline', name: 'Reject', kind: 'reject_once' }] }, 300000);
          } catch { /* A failed or timed-out dialog never grants permissions. */ }
          if (this.server.closed) return;
          const cancelled = !current() || r?.outcome?.outcome === 'cancelled';
          const accepted = !cancelled && r?.outcome?.outcome === 'selected' && r.outcome.optionId === 'accept';
          this.server.reply(m.id, permissions ? { permissions: accepted ? requested : {}, scope: 'turn' } : { decision: cancelled ? 'cancel' : accepted ? 'accept' : 'decline' });
          // Unlike command/file decisions, an empty permissions grant does not
          // itself interrupt Codex when the ACP client cancels its dialog.
          if (permissions && r?.outcome?.outcome === 'cancelled' && current()) await this.interrupt(p.threadId, active);
          return;
        }
        // Unknown blocking methods fail explicitly rather than granting permissions.
        return this.server.fail(m.id, -32601, `Client does not support ${m.method}`);
      }
      if (!s) return;
      if (m.method === 'turn/started' && s.active?.submitted) {
        if (s.active.id && s.active.id !== p.turn.id) throw new Error('Unexpected Codex turn');
        s.active.id = p.turn.id;
        if (s.active.cancel) await this.interrupt(p.threadId, s.active);
      }
      if (m.method === 'item/agentMessage/delta') {
        s.streamed.add(p.itemId); this.update(p.threadId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: p.delta } });
      } else if (m.method === 'item/reasoning/summaryTextDelta') this.update(p.threadId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: p.delta } });
      else if (m.method === 'item/started' || m.method === 'item/completed') this.item(p.threadId, p.item, m.method === 'item/completed');
      else if (m.method === 'item/commandExecution/outputDelta') {
        s.output ??= new Map();
        const text = (s.output.get(p.itemId) ?? '') + p.delta; s.output.set(p.itemId, text);
        this.update(p.threadId, { sessionUpdate: 'tool_call_update', toolCallId: p.itemId, content: [textContent(text)] });
      }
      else if (m.method === 'turn/plan/updated') this.update(p.threadId, { sessionUpdate: 'plan', entries: (p.plan ?? []).map(x => ({ content: x.step, priority: 'medium', status: x.status === 'inProgress' ? 'in_progress' : x.status })) });
      else if (m.method === 'turn/completed' && s.active?.submitted) {
        if (s.active.id && s.active.id !== p.turn.id) return;
        s.active.id = p.turn.id;
        if (p.turn.status === 'failed') this.finish(s.active, new Error(p.turn.error?.message ?? 'Codex turn failed'));
        else if (['completed', 'interrupted'].includes(p.turn.status)) this.finish(s.active, null, { stopReason: p.turn.status === 'interrupted' ? 'cancelled' : 'end_turn' });
      }
    } catch (e) {
      if (m.id !== undefined && !this.server.closed) this.server.fail(m.id, -32603, 'Client interaction failed');
      else this.server.close(e);
    }
  }
}
