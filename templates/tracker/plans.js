function planElement(tag, text, attributes = {}) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

function trackerPlanDraft(editor, lifecycle, onPreview) {
  if (!editor) return null;
  const $ = id => editor.querySelector(`#${id}`);
  const form = $('plan-editor-form'), name = $('plan-draft-name'), mode = $('plan-source-mode');
  const guided = $('plan-guided'), imports = $('plan-import'), format = $('plan-format'), upload = $('plan-upload'), text = $('plan-manifest');
  const openButton = document.getElementById('plan-new'), preview = $('plan-preview');
  const status = trackerFeedback($('plan-editor-status'));
  const rootNodes = guided.querySelector('.plan-draft-nodes');
  const bindings = [...$('plan-repositories').content.querySelectorAll('option')];
  const briefs = [...$('plan-briefs').content.querySelectorAll('option')];
  const fields = new WeakMap(), maxBytes = Number(editor.dataset.maxBytes);
  let draftScope, trigger, uploaded, importing = false, fileSelection = 0, capability = true, busy = false, blocked = false, serial = 0;
  const field = (label, element) => {
    const wrapper = planElement('label', label);
    wrapper.append(element);
    return wrapper;
  };
  const input = (length, required = true) => planElement('input', null, {
    ...(required ? { required: '' } : {}), maxlength: length, spellcheck: 'false', autocomplete: 'off',
  });
  const select = choices => {
    const el = planElement('select', null, { required: '' });
    el.append(...choices.map(([value, label]) => new Option(label, value)));
    return el;
  };
  const action = (label, work) => {
    const button = planElement('button', label, { type: 'button' });
    button.addEventListener('click', work);
    return button;
  };
  function availability() {
    openButton.disabled = !capability || busy || blocked;
    preview.disabled = !capability || busy || blocked || importing && !imports.hidden;
    preview.setAttribute('aria-busy', String(busy));
  }
  function switchMode() {
    guided.hidden = mode.value !== 'guided';
    imports.hidden = !guided.hidden;
    availability();
  }
  function consumers() {
    return [...new Set([...editor.querySelectorAll('[data-draft-node="task"]')].map(row =>
      fields.get(row).repository.selectedOptions[0]?.dataset.repository).filter(Boolean))];
  }
  function anchorFields(grid, prefix) {
    const producer = input(80), boundary = select([['terminal', 'Terminal tasks'], ['node', 'Exact task']]), target = input(2591);
    const producers = planElement('datalist', null, { id: prefix + '-producers' });
    const targets = planElement('datalist', null, { id: prefix + '-targets' });
    producer.setAttribute('list', producers.id); target.setAttribute('list', targets.id);
    const taskField = field('Producer task ID', target); taskField.hidden = true;
    const output = planElement('p', null, { role: 'status' }), lookup = trackerFeedback(output);
    let search;
    const find = async exact => {
      search?.abort(); search = new AbortController();
      const read = search, active = lifecycle.guard(), params = new URLSearchParams();
      const repositories = consumers();
      if (!repositories.length || exact && !producer.value.trim()) {
        lookup.show(repositories.length ? 'Enter a producer plan name.' : 'Choose the consumer repository on a task first.', { state: 'error' });
        return;
      }
      for (const repository of repositories) params.append('repo', repository);
      if (exact) params.set('producer', producer.value.trim());
      params.set('q', (exact ? target : producer).value.trim());
      lookup.show('Searching saved producer references…', { pending: true });
      try {
        const result = await lifecycle.read(`${BASE}/api/plan/references?${params}`, 'Producer references unavailable.', 8000, read.signal);
        if (!active() || read !== search || read.signal.aborted) return;
        const matches = exact ? result.nodes : result.producers;
        (exact ? targets : producers).replaceChildren(...matches.map(value => new Option(value)));
        lookup.show(`${matches.length} matches · ${result.omitted} omitted. ${matches.length ? 'Choose a suggestion in the field.' : 'Check the reference or operator grants.'}`);
        (exact ? target : producer).focus();
      } catch (error) { if (active() && read === search && !read.signal.aborted) lookup.show(error.message, { state: 'error' }); }
    };
    const searchNodes = action('Find producer tasks', () => find(true)); searchNodes.hidden = true;
    boundary.addEventListener('change', () => { taskField.hidden = searchNodes.hidden = boundary.value !== 'node'; });
    producer.addEventListener('input', () => targets.replaceChildren());
    grid.append(field('Producer plan name', producer), field('Frozen boundary', boundary), taskField,
      action('Find producer plans', () => find(false)), searchNodes, producers, targets, output);
    return { producer, boundary, target };
  }
  function addNode(type, container, depth = 1, focus = true) {
    if (editor.querySelectorAll('[data-draft-node]').length >= Number(editor.dataset.maxNodes) || depth > Number(editor.dataset.maxDepth)) {
      status.show('The manifest node or nesting limit has been reached.', { state: 'error' });
      return;
    }
    const row = planElement('fieldset', null, { 'data-draft-node': type });
    const title = type === 'task' ? 'Task' : type === 'group' ? 'Group' : 'Anchor';
    const id = input(80), needs = type === 'anchor' ? null : input(8192, false);
    const grid = planElement('div', null, { class: 'plan-fields' });
    const buttons = planElement('div', null, { class: 'plan-actions' });
    let record = { id, needs };
    grid.append(field(`${title} ID`, id));
    if (type === 'task') {
      const repository = select([]), prd = select([]);
      repository.append(...bindings.map(option => option.cloneNode(true)));
      const chooseBriefs = () => {
        prd.replaceChildren(new Option('Choose a ready brief', ''), ...briefs.filter(option =>
          option.dataset.binding === repository.value).map(option => option.cloneNode(true)));
      };
      repository.addEventListener('change', chooseBriefs);
      chooseBriefs();
      grid.append(field('Approved repository and base', repository), field('Ready brief', prd));
      record = { ...record, repository, prd };
    } else if (type === 'group') {
      const execution = select([['parallel', 'Parallel'], ['sequence', 'Sequence']]);
      const children = planElement('div', null, { class: 'plan-draft-children' });
      grid.append(field('Group mode', execution));
      buttons.append(action('Add nested task', () => addNode('task', children, depth + 1)),
        action('Add nested group', () => addNode('group', children, depth + 1)),
        action('Add nested anchor', () => addNode('anchor', children, depth + 1)));
      record = { ...record, execution, children };
    } else {
      record = { ...record, ...anchorFields(grid, `plan-anchor-${++serial}`) };
    }
    if (needs) grid.append(field('Needs', needs));
    buttons.append(action(`Remove ${title.toLowerCase()}`, () => {
      const parent = container.closest('[data-draft-node]');
      const fallback = container.previousElementSibling?.querySelector('button') || guided.querySelector('[data-add-plan-node]');
      row.remove();
      (parent ? fields.get(parent).id : fallback)?.focus();
    }));
    row.append(planElement('legend', title), grid, buttons);
    if (record.children) row.append(record.children);
    fields.set(row, record); container.append(row);
    if (focus) id.focus();
  }
  function serializeGuided() {
    const repositories = Object.create(null);
    function serialize(container) {
      return [...container.children].map(row => {
        const { id, needs, execution, children, repository, prd, producer, boundary, target } = fields.get(row);
        const type = row.dataset.draftNode, node = { id: id.value.trim(), type };
        if (needs?.value.trim()) node.needs = needs.value.split(',').map(value => value.trim()).filter(Boolean);
        if (type === 'anchor') {
          node.target = { plan: producer.value.trim(), ...(boundary.value === 'terminal' ? { boundary: 'terminal' } : { node: target.value.trim() }) };
        } else if (type === 'group') {
          node.mode = execution.value; node.children = serialize(children);
        } else {
          const binding = repository.selectedOptions[0].dataset;
          repositories[repository.value] = { repository: binding.repository, base: binding.base, checkout: binding.checkout };
          node.repository = repository.value; node.prd = prd.value;
        }
        return node;
      });
    }
    const nodes = serialize(rootNodes);
    return JSON.stringify({ version: 1, name: name.value.trim(), repositories, nodes });
  }
  function open(scope, button) {
    draftScope = scope; trigger = button;
    $('plan-editor-title').textContent = scope.action === 'edit' ? 'Edit future inputs' : scope.action === 'attach' ? 'Attach a producer' : 'New plan';
    if (scope.plan) { mode.value = 'import'; switchMode(); }
    if (!rootNodes.children.length) addNode('task', rootNodes, 1, false);
    editor.hidden = false;
    openButton.setAttribute('aria-expanded', 'true');
    $('plan-editor-title').focus();
  }
  openButton.addEventListener('click', () => open({ action: 'queue' }, openButton));
  $('plan-editor-close').addEventListener('click', () => {
    editor.hidden = true; openButton.setAttribute('aria-expanded', 'false');
    trigger?.focus({ preventScroll: true });
  });
  mode.addEventListener('change', switchMode);
  for (const button of guided.querySelectorAll('[data-add-plan-node]')) {
    button.addEventListener('click', () => addNode(button.dataset.addPlanNode, rootNodes));
  }
  text.addEventListener('input', () => {
    uploaded = null; upload.value = ''; fileSelection++; importing = false; availability();
  });
  upload.addEventListener('change', async () => {
    const selected = ++fileSelection, file = upload.files[0];
    uploaded = null;
    importing = false; availability();
    if (!file) return;
    text.value = '';
    const match = /\.(json|ya?ml)$/i.exec(file.name);
    if (!match || file.size > maxBytes) {
      upload.value = ''; status.show('Choose a JSON or YAML file of at most 1 MiB.', { state: 'error' });
      return;
    }
    importing = true; availability();
    try {
      const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
      if (selected !== fileSelection) return;
      uploaded = value; text.value = value; format.value = match[1].toLowerCase() === 'json' ? 'json' : 'yaml';
      status.show('Manifest loaded. Preview to validate its references.');
    } catch {
      if (selected === fileSelection) { upload.value = ''; status.show('The manifest must be valid UTF-8 text.', { state: 'error' }); }
    } finally { if (selected === fileSelection) { importing = false; availability(); } }
  });
  form.noValidate = true;
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (preview.disabled || !draftScope) return;
    if (!guided.hidden) {
      const invalid = [...guided.querySelectorAll('input, select')].find(el => !el.closest('[hidden]') && !el.validity.valid);
      if (invalid) { invalid.reportValidity(); return; }
    }
    const manifest = guided.hidden ? { format: format.value, text: uploaded ?? text.value } : { format: 'json', text: serializeGuided() };
    if (!manifest.text.trim() || new TextEncoder().encode(manifest.text).length > maxBytes) {
      status.show('Enter a manifest of at most 1 MiB.', { state: 'error' }); return;
    }
    onPreview({ ...draftScope, manifest }, preview);
  });
  availability();
  return {
    open, get openNow() { return !editor.hidden; },
    sync(enabled, pending, stale) { capability = enabled; busy = pending; blocked = stale; availability(); },
  };
}

function renderPlanReview(review, data) {
  const facts = (target, pairs) => {
    const list = planElement('dl');
    for (const [label, value] of pairs) list.append(planElement('dt', label), planElement('dd', value ?? 'Unavailable'));
    target.append(list);
  };
  // Review every item through a bounded HTML list, including large fan-outs.
  const entries = (target, title, items, describe) => {
    const details = planElement('details'), list = planElement('ul'), controls = planElement('div', null, { class: 'plan-actions' });
    const summary = planElement('summary', `${title} (${items.length})`), count = planElement('span', null, { role: 'status' });
    const earlier = planElement('button', 'Previous', { type: 'button', 'aria-label': `Previous ${title.toLowerCase()}` });
    const later = planElement('button', 'Next', { type: 'button', 'aria-label': `Next ${title.toLowerCase()}` });
    let offset = 0;
    function render() {
      const window = items.slice(offset, offset + 20);
      list.replaceChildren(...window.map(item => planElement('li', describe(item))));
      count.textContent = window.length ? `${offset + 1}–${offset + window.length} of ${items.length} · ${items.length - window.length} omitted` : 'None';
      earlier.hidden = later.hidden = items.length <= 20;
      count.hidden = items.length > 0 && items.length <= 20;
      earlier.disabled = !offset; later.disabled = offset + 20 >= items.length;
    }
    earlier.addEventListener('click', () => { offset -= 20; render(); if (earlier.disabled) later.focus(); });
    later.addEventListener('click', () => { offset += 20; render(); if (later.disabled) earlier.focus(); });
    render();
    controls.append(earlier, count, later);
    controls.hidden = count.hidden;
    details.append(summary, list, controls); target.append(details);
    return details;
  };
  const proposal = data.proposal, scope = data.scope;
  review.replaceChildren();
  const identity = planElement('details');
  identity.append(planElement('summary', 'Reviewed revision and request identity'));
  facts(identity, [
    ['Exact reviewed revision', data.revision], ['Request identity', data.requestId],
    ...(data.instanceId ? [['Plan instance', data.instanceId], ['Approval revision', data.approvalRevision]] : []),
    ...(data.expiresAt ? [['Review expires', data.expiresAt]] : []),
  ]);
  identity.open = Boolean(data.expiresAt);
  if (scope?.future) {
    review.append(planElement('p', scope.group ? `Group ${scope.group}` : 'Whole plan'));
    entries(review, 'Affected future tasks', scope.future, id => id).open = true;
    entries(review, 'Admitted tasks with independent controls', scope.admitted, id => id);
  }
  if (scope?.node) facts(review, [['Future task', scope.node], ['First failure', scope.firstFailure], ['Original run ownership retained', scope.originalStart ? 'Yes' : 'No execution submitted']]);
  if (scope?.changes) {
    facts(review, [['Approval before', scope.approval.before], ['Approval after', scope.approval.after]]);
    entries(review, 'Changed dependency contracts', scope.changes, item => `${item.id} · ${item.before ?? 'added'} → ${item.after ?? 'removed'}`);
    entries(review, 'Changed source hashes', scope.sources, item => `${item.id} · ${item.before ?? 'added'} → ${item.after ?? 'removed'}`);
  }
  if (data.artifact) {
    const url = new URL(location.href);
    url.searchParams.set('artifact', data.artifact);
    url.searchParams.delete('artifactAt'); url.searchParams.delete('fileView'); url.hash = '';
    const link = planElement('a', 'View reviewed files', { href: url.pathname + url.search,
      'data-artifact-link': '', 'aria-haspopup': 'dialog', class: 'artifact-trigger' });
    review.append(link);
  }
  if (!proposal) { review.append(identity); return; }
  review.prepend(planElement('h3', proposal.name));
  const { parallel, resources } = proposal;
  entries(review, 'Repositories and approved bases', proposal.repositories, r =>
    `${r.repository} @ ${r.base} · ${r.host} · review ${r.review}${r.reviewRoute ? ` via ${r.reviewRoute}` : ''}`).open = true;
  entries(review, 'Recorded base commits and required checks', proposal.repositories,
    r => `${r.repository} @ ${r.base} · ${r.baseCommit} · ${r.requiredChecks.join(', ') || 'No named checks configured'}`);
  entries(review, 'Recorded blockers', proposal.blockers, blocker => blocker).open = true;
  facts(review, [
    ['Dependency target', 'Integrated into approved base with a qualified receipt'],
    ['Requested parallelism', `${parallel.requestedGroups} explicit parallel groups. Independent tasks request concurrency. Manifest v1 has no numeric request.`],
    ['Admitted parallel authors', `${parallel.admitted} per plan · ${parallel.perRepository} per repository · ${parallel.preparations ?? 0} preparations`],
    ['Configured allowance per run', `USD ${proposal.budgetUsd ?? 'unknown'} · ${proposal.rounds ?? 'unknown'} task rounds`],
    ['Resource limits', `At least ${resources.freeBytes} free bytes, ${resources.freeInodes} free inodes and ${resources.memoryBytes} bytes of memory. Maximum load per CPU ${resources.loadPerCpu || 'disabled'}.`],
  ]);
  entries(review, 'Author routes and cost enforceability', proposal.tasks, task =>
    `${task.id} · ${task.repository} @ ${task.base} · ${[task.harness, task.transport, task.provider, task.model].filter(Boolean).join(' / ')} · ${task.timeoutMinutes} min · ${task.routeAvailable ? 'model access unverified' : 'route unavailable'} · ${task.providerPerRunCap ? 'provider supports a per-run cap' : 'provider cap not enforceable'}`).open = true;
  entries(review, 'Input hashes', proposal.sources, file => `${file.path} · ${file.digest}`);
  entries(review, 'Approved base-file hashes', proposal.tasks.flatMap(task => task.files.map(file => ({ ...file, id: task.id }))),
    file => `${file.id} · ${file.path} · input ${file.digest} · base ${file.baseDigest ?? 'absent'}`);
  entries(review, 'Tasks and anchors in dependency order', proposal.order, id => id);
  entries(review, 'Dependency edges', proposal.edges, edge => `${edge.from} → ${edge.to}`);
  entries(review, 'Group boundaries', proposal.groups, group =>
    `${group.id} · ${group.mode} · entries ${group.entries.join(', ')} · exits ${group.exits.join(', ')}`);
  entries(review, 'Frozen producer scopes', proposal.anchors.flatMap(anchor => anchor.nodes.map(node => ({ ...node, anchor }))),
    ({ anchor, ...node }) => `${anchor.id} · ${anchor.name} · instance ${anchor.instanceId} · revision ${anchor.revision} · ${node.id} · ${node.status} · contract ${node.contract}`);
  facts(identity, [['Graph digest', proposal.graphDigest]]);
  review.append(identity);
}

(() => {
  const root = document.querySelector?.('[data-plan-approval]');
  if (!root) return;
  const $ = id => document.getElementById('approval-' + id);
  const requestId = root.dataset.planApproval, submit = $('submit'), proposal = $('proposal');
  const refresh = $('refresh'), plan = $('plan'), signIn = $('sign-in');
  const feedback = trackerFeedback($('status')), lifecycle = trackerLifecycle();
  const href = `${BASE}/api/plan/approval?approval=${encodeURIComponent(requestId)}`;
  const messages = {
    pending: 'Pending approval. Review the files and scope before approving.',
    accepted: 'Plan approved. The admission receipt is saved.',
    stale: 'This approval request is stale. Create a new review of the current plan.',
    expired: 'This approval request expired. Create a new review.',
    denied: 'Approval denied for this repository scope.',
    unavailable: 'Approval request unavailable. Check the link and your operator access.',
  };
  let revision, ready = false, busy = false, submitting = false;
  const setBusy = value => {
    busy = value;
    submit.disabled = busy || !ready;
    submit.setAttribute('aria-busy', String(busy));
    refresh.disabled = busy;
  };
  function display(data, { fromRead = false } = {}) {
    if (data.requestId !== requestId || !Object.hasOwn(messages, data.status) ||
        (revision && data.revision && revision !== data.revision)) throw new Error('Approval identity changed.');
    revision ??= data.revision;
    if (fromRead) {
      if (data.proposal) renderPlanReview(proposal, data);
      else proposal.replaceChildren();
    }
    if (data.status === 'accepted') {
      const receipt = data.receipt;
      if (receipt?.requestId !== requestId || receipt.approvalDigest !== revision ||
          data.planLink !== `${BASE}/plans?plan=${encodeURIComponent(receipt.instanceId)}`) throw new Error('Receipt unavailable.');
      plan.href = data.planLink;
    }
    ready = data.status === 'pending' && !!root.dataset.token && /^[a-f0-9]{64}$/.test(data.revision || '') && !!data.proposal;
    submit.hidden = !ready;
    plan.hidden = data.status !== 'accepted';
    refresh.hidden = data.status !== 'unavailable' && data.status !== 'denied';
    if (signIn) signIn.hidden = data.status !== 'unavailable';
    feedback.show(messages[data.status], { state: data.status === 'accepted' ? 'success' : data.status === 'pending' ? 'idle' : 'error' });
  }
  async function read() {
    if (!requestId) { display({ requestId, status: 'unavailable' }, { fromRead: true }); return; }
    const active = lifecycle.guard();
    setBusy(true);
    try {
      const data = await lifecycle.read(href, messages.unavailable);
      if (active()) display(data, { fromRead: true });
    } catch (error) {
      if (!active()) return;
      if ([403, 404].includes(error.status)) display({ requestId, status: 'unavailable' }, { fromRead: true });
      else {
        ready = false;
        refresh.hidden = false;
        feedback.show('The saved request could not be checked. Try again to verify its current state.', { state: 'error' });
      }
    } finally { if (active()) setBusy(false); }
  }
  refresh.addEventListener('click', () => { if (!busy) read(); });
  submit.addEventListener('click', async () => {
    if (busy || !ready) return;
    ready = false;
    submitting = true;
    setBusy(true);
    $('status').tabIndex = -1;
    $('status').focus({ preventScroll: true });
    feedback.show('Submitting plan approval…', { pending: true });
    try {
      const data = await trackerControlPost(`${BASE}/api/plan/control`,
        { action: 'queue', stage: 'approve', requestId, approve: revision }, root.dataset.token, 33000);
      if (await lifecycle.whenActive()) {
        display(data);
        plan.focus({ preventScroll: true });
      }
    } catch {
      if (await lifecycle.whenActive()) {
        feedback.show('Checking whether the approval was saved…', { pending: true });
        await read();
      }
    } finally { submitting = false; setBusy(false); }
  });
  lifecycle.onResume(() => { if (!submitting) read(); });
  read().then(() => {
    if (document.activeElement === document.body) $('heading').focus({ preventScroll: true });
  });
})();

function trackerPlanControls(root, lifecycle, refresh) {
  const $ = id => document.getElementById(id);
  const dialog = $('plan-confirm'), review = $('plan-review'), submit = $('plan-submit');
  const close = $('plan-close'), check = $('plan-reconcile'), resume = $('plan-resume-receipt');
  const feedback = trackerFeedback($('plan-action-status'));
  let trigger, approval, unresolved, busy = false, stale = false, invalidated = false;
  const supportsReview = typeof dialog.showModal === 'function' && typeof globalThis.crypto?.randomUUID === 'function';
  const editor = trackerPlanDraft($('plan-editor'), lifecycle, startReview);
  const canAuthor = () => !!root.querySelector('[data-plan-authoring]');
  const selected = () => root.querySelector('[data-selected-plan]')?.dataset;
  function availability() {
    const blocked = busy || stale || !!unresolved || !supportsReview;
    root.querySelectorAll('[data-plan-action]').forEach(button => {
      button.disabled = blocked || button.hasAttribute('data-plan-edit') && !editor;
    });
    editor?.sync(canAuthor(), busy, blocked);
    submit.disabled = blocked || invalidated || !approval || approval.result.proposal?.canConfirm === false;
    close.disabled = busy;
    check.hidden = !unresolved; check.disabled = busy;
    resume.hidden = !unresolved; resume.disabled = busy;
  }
  function setBusy(value) { busy = value; availability(); }
  function commandFor(button) {
    const { planAction, planId, planGroup, planNode } = button.dataset;
    return { action: planAction, plan: planId, ...(planGroup ? { group: planGroup } : {}), ...(planNode ? { node: planNode } : {}) };
  }
  function sync(snapshotStale = stale) {
    stale = snapshotStale;
    if (approval) {
      const { result, command } = approval, view = selected();
      const changed = result.instanceId && (result.instanceId !== view?.selectedPlan ||
        result.approvalRevision !== Number(view.approvalRevision) ||
        result.controlGeneration !== Number(view.controlGeneration) || result.runtimeGeneration !== Number(view.runtimeGeneration));
      const allowed = command.manifest ? canAuthor() : [...root.querySelectorAll('[data-plan-action]')].some(button => {
        const shown = commandFor(button);
        return shown.action === command.action && shown.plan === command.plan && shown.group === command.group && shown.node === command.node;
      });
      if (!invalidated && (stale || changed || !allowed)) {
        invalidated = true;
        if (!allowed && !stale) review.replaceChildren();
        feedback.show(stale ? 'Plan observations are stale. Refresh and review again before confirming.'
          : 'The plan or your access changed. Review the current scope again.', { state: 'error' });
      }
    }
    availability();
  }
  const request = (stage, command) => trackerControlPost(`${BASE}/api/plan/control`, { workspace: true, ...command, stage }, root.dataset.token, 33000);
  function receipt(data, command) {
    return data?.requestId === command.requestId && data.status === 'applied' &&
      data.action === command.action && data.instanceId === command.plan;
  }
  function accepted() {
    unresolved = null;
    feedback.show('Reviewed future dispatch change applied.', { state: 'success' });
  }
  async function reconcile() {
    const pending = unresolved;
    feedback.show('Checking the saved request receipt…', { pending: true });
    try {
      const data = await request('reconcile', pending.command);
      if (!await lifecycle.whenActive()) return;
      if (receipt(data, pending.command)) { accepted(); return; }
      if (data.status !== 'unrecorded' || data.requestId !== pending.command.requestId || data.action !== pending.command.action) {
        throw new Error('Receipt identity unavailable');
      }
      if (pending.refusal) {
        unresolved = null;
        feedback.show(pending.refusal.message, { state: 'error' });
      } else feedback.show(`Outcome uncertain. The coordinator has no saved receipt for ${pending.command.requestId} yet. Check again before taking another action.`, { state: 'pending' });
    } catch {
      if (!await lifecycle.whenActive()) return;
      if (pending.refusal) {
        unresolved = null;
        feedback.show(pending.refusal.message, { state: 'error' });
      } else feedback.show(`Outcome uncertain. The receipt for ${pending.command.requestId} is unavailable. Check again before taking another action.`, { state: 'pending' });
    }
  }
  async function startReview(input, button) {
    if (busy || stale || unresolved || dialog.open || !supportsReview) return;
    trigger = button; approval = null; invalidated = false;
    const command = { ...input, requestId: crypto.randomUUID() };
    submit.textContent = input.action === 'queue' ? 'Create approval request' : 'Confirm reviewed action';
    $('plan-confirm-title').textContent = input.action === 'queue' ? 'Review plan proposal' : 'Review plan action';
    review.replaceChildren(); setBusy(true);
    feedback.show('Reviewing the requested scope…', { pending: true });
    dialog.showModal(); review.focus();
    try {
      const result = await request('review', command);
      if (!await lifecycle.whenActive()) return;
      if (result.status !== 'review' || result.requestId !== command.requestId || result.action !== command.action ||
        !/^[a-f0-9]{64}$/.test(result.revision || '') || command.plan && result.instanceId !== command.plan ||
        command.action === 'queue' && !/^[a-z0-9]{8,12}-[a-f0-9-]{36}$/.test(result.saveRequestId || '')) throw new Error('The review response identity could not be verified.');
      renderPlanReview(review, result);
      approval = { result, command };
      feedback.show(result.proposal?.canConfirm === false ? 'This proposal requires a queue grant.' :
        command.action === 'queue' ? 'Review ready. Save a link to this exact proposal.' : 'Review ready. Confirm to accept this exact scope.');
      sync();
    } catch (error) {
      if (await lifecycle.whenActive()) feedback.show(error.refused ? error.message : 'Review unavailable. Check the request and preview again.', { state: 'error' });
    } finally { setBusy(false); }
  }
  root.addEventListener('click', event => {
    const button = event.target.closest('[data-plan-action]');
    if (!button || button.disabled) return;
    if (button.hasAttribute('data-plan-edit')) editor?.open(commandFor(button), button);
    else startReview(commandFor(button), button);
  });
  submit.addEventListener('click', async () => {
    if (submit.disabled || !approval) return;
    const command = { ...approval.command, approve: approval.result.revision };
    if (command.action === 'queue') {
      command.requestId = approval.result.saveRequestId;
      setBusy(true);
      feedback.show('Saving the approval request…', { pending: true });
      try {
        const data = await request('save', command);
        if (!await lifecycle.whenActive()) return;
        const link = `${BASE}/plans?approval=${encodeURIComponent(command.requestId)}`;
        if (data.approvalLink !== link || data.revision !== command.approve) throw new Error('Approval request unavailable.');
        invalidated = true;
        location.assign(link);
      } catch (error) {
        if (!await lifecycle.whenActive()) return;
        invalidated = error.code === 'PLAN_STALE';
        feedback.show(error.refused ? error.message : 'The approval link could not be verified. Try saving the same request again.', { state: 'error' });
      } finally { setBusy(false); }
      return;
    }
    approval = null; setBusy(true);
    feedback.show('Confirming the reviewed scope…', { pending: true });
    try {
      const data = await request('confirm', command);
      if (!await lifecycle.whenActive()) return;
      if (!receipt(data, command)) throw new Error('Receipt identity unconfirmed');
      accepted();
    } catch (error) {
      if (!await lifecycle.whenActive()) return;
      unresolved = { command, refusal: error.refused ? error : null };
      await reconcile();
    } finally { setBusy(false); }
  });
  check.addEventListener('click', async () => {
    if (busy || !unresolved) return;
    setBusy(true);
    try { await reconcile(); } finally { setBusy(false); }
  });
  resume.addEventListener('click', () => { trigger = resume; dialog.showModal(); check.focus(); });
  function dismissReview() {
    if (busy || !dialog.open) return;
    dialog.close();
    approval = null;
    (trigger?.getClientRects().length && !trigger.disabled ? trigger : unresolved ? resume : $('chains-refresh')).focus({ preventScroll: true });
    refresh();
  }
  close.addEventListener('click', dismissReview);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    dismissReview();
  });
  availability();
  return { sync, get busy() { return busy; }, get held() { return dialog.open || editor?.openNow; } };
}
