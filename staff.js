(() => {
  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const accessShell = qs('[data-access-shell]');
  const onboardingShell = qs('[data-onboarding]');
  const operations = qs('[data-operations]');
  const sessionActions = qs('[data-session-actions]');
  const workspaceStatus = qs('[data-workspace-status]');
  const loginForm = qs('[data-login-form]');
  const temporaryPasswordForm = qs('[data-temporary-password-form]');
  const passwordChangeForm = qs('[data-password-change-form]');
  const inviteForm = qs('[data-invite-form]');
  const accessForms = [loginForm, temporaryPasswordForm, passwordChangeForm, inviteForm];
  const csrfStorageKey = 'seven-roots-staff-csrf';
  let csrfToken = sessionStorage.getItem(csrfStorageKey) || '';
  let workspace = null;
  let onboarding = null;
  let activeTrainingModuleId = '';

  const permission = (name) => Boolean(workspace?.user?.permissions?.includes(name));
  const locationLabel = (location) => location === 'us' ? 'U.S. fulfillment' : location === 'liberia' ? 'Liberia warehouse' : 'Both locations';
  const statusLabel = (value) => String(value || 'unknown').replaceAll('_', ' ');
  const formatDate = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? 'Not available' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  };
  const formatMoney = (amount, currency) => Number.isInteger(amount) && currency
    ? new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount / 100)
    : 'Not available';
  const setStatus = (element, message, isError = false) => {
    element.textContent = message;
    element.classList.toggle('is-error', isError);
  };
  const showAccessForm = (form) => {
    accessShell.hidden = false;
    for (const candidate of accessForms) candidate.hidden = candidate !== form;
  };
  const statusClass = (value) => {
    if (['blocked', 'changes_requested', 'sold_out', 'rejected', 'returned', 'inactive'].includes(value)) return ' is-danger';
    if (['urgent', 'pending_approval', 'low_stock', 'submitted', 'approved_pending_zoho', 'in_transit', 'unfulfilled'].includes(value)) return ' is-warning';
    return '';
  };
  const makeStatus = (value) => {
    const badge = document.createElement('span');
    badge.className = `status-label${statusClass(value)}`;
    badge.textContent = statusLabel(value);
    return badge;
  };

  const api = async (path, options = {}) => {
    const method = options.method || 'GET';
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' && csrfToken ? { 'x-csrf-token': csrfToken } : {})
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {})
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error?.message || 'The staff API could not complete this request.');
      error.code = payload.error?.code || 'request_failed';
      error.details = payload.error?.details || {};
      throw error;
    }
    return payload.data;
  };

  const uploadFile = async (path, file, { kind, phase } = {}) => {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'content-type': file.type || 'application/octet-stream',
        'x-csrf-token': csrfToken,
        'x-file-name': file.name,
        ...(kind ? { 'x-file-kind': kind } : {}),
        ...(phase ? { 'x-file-phase': phase } : {})
      },
      body: file
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error?.message || 'The file could not be uploaded.');
    return payload.data;
  };

  const workFileKind = (file) => file.type.startsWith('image/') ? 'photo' : file.type.startsWith('video/') ? 'video' : 'document';
  const whatsappUrl = (number, message = '') => {
    const digits = String(number || '').replace(/\D/g, '');
    return digits ? `https://wa.me/${digits}${message ? `?text=${encodeURIComponent(message)}` : ''}` : '';
  };

  const actionButton = (label, action, secondary = false) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (secondary) button.className = 'secondary';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await action(); } catch (error) { setStatus(workspaceStatus, error.message, true); } finally { button.disabled = false; }
    });
    return button;
  };

  const runWorkspaceAction = async (path, options, message) => {
    setStatus(workspaceStatus, 'Saving your update...');
    await api(path, options);
    await loadWorkspace();
    setStatus(workspaceStatus, message);
  };

  const todayInputValue = () => {
    const now = new Date();
    const local = new Date(now.valueOf() - now.getTimezoneOffset() * 60 * 1000);
    return local.toISOString().slice(0, 10);
  };

  const onboardingStatusLabel = (value) => ({
    not_started: 'Not started',
    in_progress: 'Training in progress',
    pending_review: 'Pending management review',
    changes_requested: 'Changes requested',
    approved: 'Approved'
  })[value] || statusLabel(value);

  const renderTrainingLesson = () => {
    const stage = qs('[data-training-lesson]');
    stage.replaceChildren();
    const module = onboarding.catalog.find((item) => item.id === activeTrainingModuleId) || onboarding.catalog[0];
    if (!module) return;
    activeTrainingModuleId = module.id;
    const completed = onboarding.completedModuleIds.includes(module.id);
    const locked = onboarding.status === 'pending_review';

    const documentBar = document.createElement('div');
    documentBar.className = 'controlled-document';
    const documentIdentity = document.createElement('div');
    const documentLabel = document.createElement('span');
    documentLabel.textContent = 'Controlled onboarding document';
    const documentNumber = document.createElement('strong');
    documentNumber.textContent = module.documentNumber || `SR-TRN-${String(module.order).padStart(3, '0')}`;
    documentIdentity.append(documentLabel, documentNumber);
    const documentMeta = document.createElement('dl');
    [['Revision', module.revision || '1.0'], ['Effective', module.effectiveDate || 'Current'], ['Owner', module.owner || 'SEVEN ROOTS Management']].forEach(([term, value]) => {
      const group = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = value;
      group.append(dt, dd);
      documentMeta.append(group);
    });
    const printButton = document.createElement('button');
    printButton.type = 'button';
    printButton.className = 'document-print';
    printButton.textContent = 'Print / save document';
    printButton.addEventListener('click', () => window.print());
    documentBar.append(documentIdentity, documentMeta, printButton);

    const header = document.createElement('header');
    const number = document.createElement('span');
    number.className = 'lesson-number';
    number.textContent = String(module.order).padStart(2, '0');
    const heading = document.createElement('div');
    const meta = document.createElement('p');
    meta.className = 'lesson-meta';
    meta.textContent = `${module.code} · ${module.duration}${completed ? ' · Complete' : ''}`;
    const title = document.createElement('h2');
    title.textContent = module.title;
    const objective = document.createElement('p');
    objective.textContent = module.objective;
    heading.append(meta, title, objective);
    header.append(number, heading);

    const sections = document.createElement('div');
    sections.className = 'lesson-sections';
    module.sections.forEach((item) => {
      const section = document.createElement('section');
      const sectionTitle = document.createElement('h3');
      sectionTitle.textContent = item.heading;
      const list = document.createElement('ul');
      item.points.forEach((point) => {
        const li = document.createElement('li');
        li.textContent = point;
        list.append(li);
      });
      section.append(sectionTitle, list);
      sections.append(section);
    });

    const check = document.createElement('form');
    check.className = 'knowledge-check';
    const label = document.createElement('p');
    label.className = 'form-label';
    label.textContent = 'Knowledge check';
    const question = document.createElement('h3');
    question.textContent = module.question;
    const options = document.createElement('fieldset');
    options.disabled = locked;
    module.options.forEach((option) => {
      const optionLabel = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'answer';
      input.value = option.id;
      input.required = true;
      const copy = document.createElement('span');
      copy.textContent = option.label;
      optionLabel.append(input, copy);
      options.append(optionLabel);
    });
    const button = document.createElement('button');
    button.type = 'submit';
    button.disabled = locked;
    button.textContent = completed ? 'Review and reconfirm module' : 'Complete module';
    check.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(check);
      button.disabled = true;
      setStatus(qs('[data-onboarding-message]'), `Checking ${module.title}…`);
      try {
        onboarding = await api(`/api/v1/staff/onboarding/modules/${encodeURIComponent(module.id)}/complete`, {
          method: 'POST', body: { answer: form.get('answer') }
        });
        const next = onboarding.catalog.find((item) => !onboarding.completedModuleIds.includes(item.id));
        activeTrainingModuleId = next?.id || module.id;
        renderOnboarding();
        setStatus(qs('[data-onboarding-message]'), `${module.title} completed. Your progress was saved.`);
      } catch (error) {
        setStatus(qs('[data-onboarding-message]'), error.message, true);
        button.disabled = false;
      }
    });
    check.append(label, question, options, button);
    const recordNotice = document.createElement('aside');
    recordNotice.className = 'training-record-notice';
    const noticeTitle = document.createElement('strong');
    noticeTitle.textContent = 'Employee record notice';
    const noticeCopy = document.createElement('p');
    noticeCopy.textContent = 'Completing this knowledge check records your employee ID, result, and completion time. All four documents must be completed before the signed onboarding packet can be submitted to management.';
    recordNotice.append(noticeTitle, noticeCopy);
    stage.append(documentBar, header, sections, recordNotice, check);
  };

  const renderOnboardingReviewState = () => {
    const panel = qs('[data-onboarding-review-state]');
    panel.replaceChildren();
    const pending = onboarding.status === 'pending_review';
    const changes = onboarding.status === 'changes_requested';
    panel.hidden = !(pending || changes);
    if (panel.hidden) return;
    panel.className = `onboarding-review-state${changes ? ' is-changes' : ''}`;
    const symbol = document.createElement('span');
    symbol.className = 'review-state-symbol';
    symbol.textContent = pending ? '…' : '!';
    const copy = document.createElement('div');
    const title = document.createElement('h2');
    title.textContent = pending ? 'Your record is with management' : 'Management requested changes';
    const body = document.createElement('p');
    body.textContent = pending
      ? `Submitted ${formatDate(onboarding.submittedAt)}. Your staff dashboard will open after an authorized manager reviews and signs this record.`
      : (onboarding.review?.note || 'Review the training record, make the requested correction, and submit it again.');
    copy.append(title, body);
    if (onboarding.review?.reviewedByName) {
      const reviewer = document.createElement('small');
      reviewer.textContent = `${onboarding.review.reviewedByName} · ${formatDate(onboarding.review.reviewedAt)}`;
      copy.append(reviewer);
    }
    panel.append(symbol, copy);
  };

  const renderOnboarding = () => {
    accessShell.hidden = true;
    operations.hidden = true;
    onboardingShell.hidden = false;
    sessionActions.hidden = false;
    qs('[data-session-identity]').textContent = `${onboarding.user.name} | Onboarding`;
    qs('[data-onboarding-employee]').textContent = `${onboarding.user.employeeNumber} · ${onboarding.user.name}`;
    qs('[data-onboarding-status]').textContent = onboardingStatusLabel(onboarding.status);
    qs('[data-onboarding-progress]').textContent = `${onboarding.completedModules} of ${onboarding.totalModules} modules complete`;
    qs('[data-training-progress-bar]').style.width = `${Math.round((onboarding.completedModules / Math.max(1, onboarding.totalModules)) * 100)}%`;

    if (!activeTrainingModuleId) activeTrainingModuleId = onboarding.catalog.find((module) => !onboarding.completedModuleIds.includes(module.id))?.id || onboarding.catalog[0]?.id || '';
    const moduleList = qs('[data-training-module-list]');
    moduleList.replaceChildren();
    onboarding.catalog.forEach((module) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = onboarding.completedModuleIds.includes(module.id) ? 'is-complete' : '';
      if (module.id === activeTrainingModuleId) button.setAttribute('aria-current', 'step');
      const code = document.createElement('span');
      code.textContent = module.code;
      const title = document.createElement('strong');
      title.textContent = module.title;
      const state = document.createElement('small');
      state.textContent = onboarding.completedModuleIds.includes(module.id) ? 'Complete' : module.duration;
      button.append(code, title, state);
      button.addEventListener('click', () => {
        activeTrainingModuleId = module.id;
        renderOnboarding();
      });
      moduleList.append(button);
    });
    renderTrainingLesson();

    const formSection = qs('[data-onboarding-submit]');
    formSection.hidden = onboarding.status === 'pending_review';
    const form = qs('[data-onboarding-form]');
    form.elements.signedName.value = onboarding.signedName || onboarding.user.name;
    form.elements.signedDate.value = onboarding.signedDate || todayInputValue();
    const photoUrl = onboarding.employeePhotoUrl || onboarding.currentEmployeePhotoUrl;
    const signatureUrl = onboarding.employeeSignatureUrl || onboarding.currentEmployeeSignatureUrl;
    const photo = qs('[data-onboarding-photo]');
    const signature = qs('[data-onboarding-signature]');
    photo.hidden = !photoUrl;
    signature.hidden = !signatureUrl;
    qs('[data-onboarding-photo-empty]').hidden = Boolean(photoUrl);
    qs('[data-onboarding-signature-empty]').hidden = Boolean(signatureUrl);
    if (photoUrl) photo.src = photoUrl;
    if (signatureUrl) signature.src = signatureUrl;
    const acknowledgments = qs('[data-onboarding-acknowledgments]');
    acknowledgments.replaceChildren();
    const legend = document.createElement('legend');
    legend.textContent = 'Required acknowledgments';
    acknowledgments.append(legend);
    onboarding.requiredAcknowledgments.forEach((item) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'acknowledgments';
      input.value = item.id;
      input.required = true;
      input.checked = onboarding.acknowledgments.includes(item.id);
      const text = document.createElement('span');
      text.textContent = item.label;
      label.append(input, text);
      acknowledgments.append(label);
    });
    const submit = qs('[data-onboarding-submit-button]');
    submit.disabled = onboarding.completedModules !== onboarding.totalModules;
    submit.title = submit.disabled ? 'Complete all four training modules first.' : '';
    renderOnboardingReviewState();
  };

  const renderTasks = () => {
    const form = qs('[data-task-form]');
    form.hidden = !permission('tasks.manage');
    const locationSelect = qs('[data-task-location]');
    const selectedLocation = locationSelect.value;
    locationSelect.replaceChildren();
    workspace.user.locations.forEach((location) => locationSelect.append(new Option(locationLabel(location), location)));
    if (workspace.user.role === 'owner') locationSelect.append(new Option('Both locations', 'both'));
    if ([...locationSelect.options].some((option) => option.value === selectedLocation)) locationSelect.value = selectedLocation;

    const assigneeSelect = qs('[data-task-assignee]');
    const selectedAssignee = assigneeSelect.value;
    assigneeSelect.replaceChildren(new Option('Open to claim', ''));
    workspace.directory.forEach((person) => assigneeSelect.append(new Option(`${person.name} · ${person.roleLabel}`, person.id)));
    assigneeSelect.value = selectedAssignee;
    const personById = new Map(workspace.directory.map((person) => [person.id, person]));

    const list = qs('[data-task-list]');
    list.replaceChildren();
    if (!workspace.tasks.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No work is waiting for this role and location.';
      list.append(empty);
      return;
    }

    workspace.tasks.forEach((task) => {
      const card = document.createElement('article');
      card.className = `task-card${task.status === 'completed' ? ' is-completed' : ''}`;
      const header = document.createElement('header');
      const identity = document.createElement('div');
      const eyebrow = document.createElement('small');
      eyebrow.textContent = `${statusLabel(task.type)} · ${locationLabel(task.location)}`;
      const title = document.createElement('h3');
      title.textContent = task.title;
      identity.append(eyebrow, title);
      const badges = document.createElement('div');
      badges.className = 'task-badges';
      if (task.priority === 'urgent' && task.status !== 'completed') badges.append(makeStatus('urgent'));
      badges.append(makeStatus(task.status));
      header.append(identity, badges);

      const scope = document.createElement('section');
      scope.className = 'task-scope';
      const scopeLabel = document.createElement('strong');
      scopeLabel.textContent = 'Scope of Work';
      const scopeText = document.createElement('p');
      scopeText.textContent = task.scopeOfWork || task.description || 'No Scope of Work was recorded.';
      scope.append(scopeLabel, scopeText);

      const details = document.createElement('dl');
      details.className = 'task-details';
      const assignee = personById.get(task.assignedTo);
      const latestNotification = task.notifications?.[0];
      const detailEntries = [
        ['Assigned to', assignee?.name || (task.assignedTo === workspace.user.id ? workspace.user.name : 'Open to claim')],
        ['Due', task.dueAt ? formatDate(task.dueAt) : 'No due date'],
        ['Created by', task.createdByName],
        ['Updated', formatDate(task.updatedAt)],
        ['WhatsApp', latestNotification ? statusLabel(latestNotification.status) : 'No notification']
      ];
      detailEntries.forEach(([term, value]) => {
        const group = document.createElement('div');
        const dt = document.createElement('dt');
        dt.textContent = term;
        const dd = document.createElement('dd');
        dd.textContent = value || 'Not available';
        group.append(dt, dd);
        details.append(group);
      });

      const files = document.createElement('section');
      files.className = 'task-files-panel';
      const fileTitle = document.createElement('strong');
      fileTitle.textContent = `Work files · ${task.attachments.length}`;
      const fileList = document.createElement('div');
      fileList.className = 'task-file-list';
      if (!task.attachments.length) {
        const empty = document.createElement('span');
        empty.textContent = 'No SOW, reference, or completion files uploaded yet.';
        fileList.append(empty);
      }
      task.attachments.forEach((file) => {
        const link = document.createElement('a');
        link.href = file.downloadUrl;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = `${file.phase === 'scope' ? 'SOW' : 'Proof'} · ${file.originalName}`;
        fileList.append(link);
      });
      files.append(fileTitle, fileList);

      const evidence = document.createElement('div');
      evidence.className = 'evidence-checklist';
      (task.evidenceRequirements || []).forEach((requirement) => {
        const complete = task.attachments.some((file) => file.phase === 'completion' && file.family === requirement);
        const item = document.createElement('span');
        item.className = complete ? 'is-ready' : '';
        item.textContent = `${complete ? '✓' : '○'} ${statusLabel(requirement)}`;
        evidence.append(item);
      });

      const actions = document.createElement('div');
      actions.className = 'task-actions task-primary-actions';
      const isAssignee = task.assignedTo === workspace.user.id;
      const canWork = permission('tasks.update') && (!task.assignedTo || isAssignee);
      if (canWork && task.status === 'open') {
        actions.append(actionButton(task.assignedTo ? 'Start task' : 'Claim task', () => runWorkspaceAction(
          `/api/v1/staff/tasks/${encodeURIComponent(task.id)}`,
          { method: 'PATCH', body: { assignedTo: workspace.user.id, status: 'in_progress' } },
          `${task.title} is now in progress.`
        )));
      }
      if (canWork && task.status === 'blocked') {
        actions.append(actionButton('Resume task', () => runWorkspaceAction(
          `/api/v1/staff/tasks/${encodeURIComponent(task.id)}`,
          { method: 'PATCH', body: { status: 'in_progress' } }, `${task.title} was resumed.`
        )));
      }
      if (canWork && task.status === 'in_progress') {
        actions.append(actionButton('Mark blocked', () => runWorkspaceAction(
          `/api/v1/staff/tasks/${encodeURIComponent(task.id)}`,
          { method: 'PATCH', body: { status: 'blocked' } }, `${task.title} was marked blocked.`
        ), true));
      }
      const contactUrl = whatsappUrl(assignee?.whatsappNumber, `Hello ${assignee?.name || ''}, I am contacting you about the SEVEN ROOTS task: ${task.title}.`);
      if (contactUrl && permission('tasks.manage')) {
        const contact = document.createElement('a');
        contact.className = 'task-whatsapp';
        contact.href = contactUrl;
        contact.target = '_blank';
        contact.rel = 'noopener';
        contact.textContent = 'WhatsApp employee';
        actions.append(contact);
      }

      card.append(header, scope, details, files, evidence, actions);

      if (isAssignee && ['in_progress', 'changes_requested'].includes(task.status)) {
        const submission = document.createElement('form');
        submission.className = 'task-submission';
        const heading = document.createElement('div');
        const submitTitle = document.createElement('strong');
        submitTitle.textContent = task.status === 'changes_requested' ? 'Manager requested changes' : 'Completion evidence';
        const reviewText = document.createElement('p');
        reviewText.textContent = task.reviewNote || 'Upload every required file, then submit the task for manager approval.';
        heading.append(submitTitle, reviewText);
        const uploadLabel = document.createElement('label');
        const uploadText = document.createElement('span');
        uploadText.textContent = 'Documents, photos, or video';
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = '.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,image/*,video/mp4,video/webm,video/quicktime';
        uploadLabel.append(uploadText, input);
        const uploadButton = document.createElement('button');
        uploadButton.type = 'button';
        uploadButton.textContent = 'Upload selected proof';
        uploadButton.addEventListener('click', async () => {
          const selected = [...input.files];
          if (!selected.length) return setStatus(workspaceStatus, 'Choose at least one work file.', true);
          uploadButton.disabled = true;
          try {
            for (const file of selected) {
              setStatus(workspaceStatus, `Uploading ${file.name}…`);
              await uploadFile(`/api/v1/staff/tasks/${encodeURIComponent(task.id)}/files`, file, { kind: workFileKind(file), phase: 'completion' });
            }
            await loadWorkspace();
            setStatus(workspaceStatus, `${selected.length} completion file${selected.length === 1 ? '' : 's'} uploaded.`);
          } catch (error) { setStatus(workspaceStatus, error.message, true); } finally { uploadButton.disabled = false; }
        });
        const noteLabel = document.createElement('label');
        const noteText = document.createElement('span');
        noteText.textContent = 'Completion note for manager';
        const note = document.createElement('textarea');
        note.maxLength = 1200;
        note.required = true;
        note.placeholder = 'Summarize completed work and identify the uploaded proof.';
        noteLabel.append(noteText, note);
        const submitButton = document.createElement('button');
        submitButton.type = 'submit';
        submitButton.textContent = 'Submit for approval';
        submission.addEventListener('submit', async (event) => {
          event.preventDefault();
          submitButton.disabled = true;
          try {
            await runWorkspaceAction(`/api/v1/staff/tasks/${encodeURIComponent(task.id)}/submit`, {
              method: 'POST', body: { submissionNote: note.value }
            }, `${task.title} is pending manager approval.`);
          } catch (error) { setStatus(workspaceStatus, error.message, true); } finally { submitButton.disabled = false; }
        });
        submission.append(heading, uploadLabel, uploadButton, noteLabel, submitButton);
        card.append(submission);
      }

      if (task.status === 'pending_approval') {
        const pending = document.createElement('section');
        pending.className = 'task-pending';
        const pendingTitle = document.createElement('strong');
        pendingTitle.textContent = 'Pending manager approval';
        const pendingCopy = document.createElement('p');
        pendingCopy.textContent = `${task.submittedByName} submitted this work ${formatDate(task.submittedAt)}. ${task.submissionNote}`;
        pending.append(pendingTitle, pendingCopy);
        if (permission('tasks.approve') && task.submittedBy !== workspace.user.id) {
          const review = document.createElement('form');
          review.className = 'task-review';
          const note = document.createElement('textarea');
          note.maxLength = 1200;
          note.placeholder = 'Approval note or required corrections';
          note.setAttribute('aria-label', `Review note for ${task.title}`);
          const approve = document.createElement('button');
          approve.type = 'button';
          approve.textContent = 'Approve and sign';
          approve.disabled = !workspace.user.profileReady;
          approve.title = workspace.user.profileReady ? '' : 'Upload your profile photo and signature first.';
          approve.addEventListener('click', async () => {
            approve.disabled = true;
            try {
              await runWorkspaceAction(`/api/v1/staff/tasks/${encodeURIComponent(task.id)}/review`, {
                method: 'POST', body: { decision: 'approve', reviewNote: note.value }
              }, `${task.title} was approved and completed.`);
            } catch (error) { setStatus(workspaceStatus, error.message, true); } finally { approve.disabled = !workspace.user.profileReady; }
          });
          const changes = document.createElement('button');
          changes.type = 'button';
          changes.className = 'secondary';
          changes.textContent = 'Request changes';
          changes.addEventListener('click', async () => {
            changes.disabled = true;
            try {
              await runWorkspaceAction(`/api/v1/staff/tasks/${encodeURIComponent(task.id)}/review`, {
                method: 'POST', body: { decision: 'request_changes', reviewNote: note.value }
              }, `${task.title} was returned for changes.`);
            } catch (error) { setStatus(workspaceStatus, error.message, true); } finally { changes.disabled = false; }
          });
          review.append(note, approve, changes);
          pending.append(review);
        }
        card.append(pending);
      }

      if (task.status === 'completed' && task.approval) {
        const seal = document.createElement('section');
        seal.className = 'approval-seal';
        const check = document.createElement('span');
        check.className = 'approval-check';
        check.textContent = '✓';
        const approvedCopy = document.createElement('div');
        const approvedTitle = document.createElement('strong');
        approvedTitle.textContent = 'Approved and completed';
        const approvedBy = document.createElement('p');
        approvedBy.textContent = `${task.approval.approvedByName} · ${formatDate(task.approval.approvedAt)}`;
        approvedCopy.append(approvedTitle, approvedBy);
        if (task.approval.approverPhotoUrl) {
          const photo = document.createElement('img');
          photo.className = 'approver-photo';
          photo.src = task.approval.approverPhotoUrl;
          photo.alt = `${task.approval.approvedByName}, approving manager`;
          seal.append(photo);
        }
        seal.append(check, approvedCopy);
        if (task.approval.approverSignatureUrl) {
          const signature = document.createElement('img');
          signature.className = 'approval-signature';
          signature.src = task.approval.approverSignatureUrl;
          signature.alt = `${task.approval.approvedByName}'s approval signature`;
          seal.append(signature);
        }
        card.append(seal);
      }

      list.append(card);
    });
  };

  const renderInventory = () => {
    const source = qs('[data-inventory-source]');
    source.textContent = workspace.zoho?.inventoryAuthority ? 'Zoho controlled' : 'Local readiness mode';
    source.className = `source-badge${workspace.zoho?.inventoryAuthority ? '' : ' is-warning'}`;
    const grid = qs('[data-staff-inventory]');
    grid.replaceChildren();
    if (!permission('inventory.view')) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Inventory access is not assigned to this role.';
      grid.append(empty);
    } else {
      workspace.inventory.forEach((item) => {
        const card = document.createElement('article');
        card.className = 'inventory-card';
        const header = document.createElement('header');
        const heading = document.createElement('div');
        const title = document.createElement('h3');
        title.textContent = item.formatName;
        const location = document.createElement('small');
        location.textContent = `${locationLabel(item.location)} | ${item.sku}`;
        heading.append(title, location);
        header.append(heading, makeStatus(item.status));
        const data = document.createElement('dl');
        [['On hand', item.tracking ? item.stockOnHand : 'Not tracked'], ['Reorder at', item.reorderLevel]].forEach(([label, value]) => {
          const group = document.createElement('div');
          const term = document.createElement('dt');
          term.textContent = label;
          const description = document.createElement('dd');
          description.textContent = value;
          group.append(term, description);
          data.append(group);
        });
        card.append(header, data);
        if (permission('inventory.count')) {
          const form = document.createElement('form');
          form.className = 'count-form';
          const quantityLabel = document.createElement('label');
          const quantityText = document.createElement('span');
          quantityText.textContent = 'Physical count';
          const quantity = document.createElement('input');
          quantity.type = 'number';
          quantity.min = '0';
          quantity.max = '1000000';
          quantity.required = true;
          quantityLabel.append(quantityText, quantity);
          const reasonLabel = document.createElement('label');
          const reasonText = document.createElement('span');
          reasonText.textContent = 'Reason';
          const reason = document.createElement('input');
          reason.maxLength = 240;
          reason.value = 'Physical inventory count';
          reasonLabel.append(reasonText, reason);
          const submit = document.createElement('button');
          submit.type = 'submit';
          submit.textContent = 'Submit';
          form.append(quantityLabel, reasonLabel, submit);
          form.addEventListener('submit', async (event) => {
            event.preventDefault();
            submit.disabled = true;
            try {
              await runWorkspaceAction('/api/v1/staff/inventory/counts', {
                method: 'POST',
                body: { location: item.location, formatSlug: item.formatSlug, countedStock: Number(quantity.value), reason: reason.value }
              }, `${item.formatName} count was submitted.`);
            } catch (error) {
              setStatus(workspaceStatus, error.message, true);
            } finally { submit.disabled = false; }
          });
          card.append(form);
        }
        grid.append(card);
      });
    }

    const countList = qs('[data-count-list]');
    countList.replaceChildren();
    if (!workspace.stockCounts.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No physical counts have been submitted.';
      countList.append(empty);
      return;
    }
    workspace.stockCounts.forEach((count) => {
      const row = document.createElement('article');
      row.className = 'count-row';
      const meta = document.createElement('div');
      meta.className = 'count-meta';
      const number = document.createElement('strong');
      number.textContent = count.countNumber;
      const product = document.createElement('span');
      product.textContent = `${count.formatName} | ${locationLabel(count.location)}`;
      const submitter = document.createElement('span');
      submitter.textContent = `Submitted by ${count.submittedByName}`;
      meta.append(number, product, submitter);
      const expected = document.createElement('div');
      expected.className = 'count-quantity';
      expected.textContent = count.expectedStock ?? 'Not tracked';
      const expectedLabel = document.createElement('small');
      expectedLabel.textContent = 'Expected';
      expected.append(expectedLabel);
      const counted = document.createElement('div');
      counted.className = 'count-quantity';
      counted.textContent = count.countedStock;
      const countedLabel = document.createElement('small');
      countedLabel.textContent = 'Counted';
      counted.append(countedLabel);
      const variance = document.createElement('div');
      variance.className = 'count-quantity';
      variance.textContent = count.variance ?? 'Not available';
      const varianceLabel = document.createElement('small');
      varianceLabel.textContent = 'Variance';
      variance.append(varianceLabel);
      const actions = document.createElement('div');
      actions.className = 'task-actions';
      actions.append(makeStatus(count.status));
      if (permission('inventory.approve') && count.status === 'submitted' && count.submittedBy !== workspace.user.id) {
        actions.append(actionButton('Approve', () => runWorkspaceAction(
          `/api/v1/staff/inventory/counts/${encodeURIComponent(count.id)}/review`,
          { method: 'POST', body: { decision: 'approve' } },
          `${count.countNumber} was approved.`
        )));
        actions.append(actionButton('Reject', () => runWorkspaceAction(
          `/api/v1/staff/inventory/counts/${encodeURIComponent(count.id)}/review`,
          { method: 'POST', body: { decision: 'reject' } },
          `${count.countNumber} was rejected.`
        ), true));
      }
      row.append(meta, expected, counted, variance, actions);
      countList.append(row);
    });
  };

  const renderTransfers = () => {
    qs('[data-transfer-form]').hidden = !permission('transfers.create');
    const list = qs('[data-transfer-list]');
    list.replaceChildren();
    if (!permission('transfers.view') || !workspace.transfers.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = permission('transfers.view') ? 'No Liberia to U.S. transfers have been prepared.' : 'Transfer access is not assigned to this role.';
      list.append(empty);
      return;
    }
    workspace.transfers.forEach((transfer) => {
      const card = document.createElement('article');
      card.className = 'transfer-card';
      const copy = document.createElement('div');
      const title = document.createElement('h3');
      title.textContent = transfer.transferNumber;
      const route = document.createElement('p');
      route.textContent = `${locationLabel(transfer.fromLocation)} to ${locationLabel(transfer.toLocation)}`;
      copy.append(title, route, makeStatus(transfer.status));
      const items = document.createElement('div');
      items.className = 'transfer-items';
      transfer.items.forEach((item) => {
        const line = document.createElement('span');
        line.textContent = `${item.quantity} x ${item.formatName}`;
        items.append(line);
      });
      const shipping = document.createElement('div');
      shipping.className = 'transfer-shipping';
      const shippingTitle = document.createElement('strong');
      shippingTitle.textContent = transfer.status === 'in_transit' ? 'Shipment details' : 'Control record';
      const shippingText = document.createElement('span');
      shippingText.textContent = [transfer.carrier, transfer.trackingNumber, transfer.freightReference, transfer.zohoTransferOrderNumber].filter(Boolean).join(' | ') || `Updated ${formatDate(transfer.updatedAt)}`;
      shipping.append(shippingTitle, shippingText);
      const actions = document.createElement('div');
      actions.className = 'transfer-actions';
      if (transfer.status === 'draft' && permission('transfers.approve')) {
        actions.append(actionButton('Approve', () => runWorkspaceAction(
          `/api/v1/staff/transfers/${encodeURIComponent(transfer.id)}/approve`, { method: 'POST' }, `${transfer.transferNumber} was approved.`
        )));
      }
      if (transfer.status === 'approved' && permission('transfers.dispatch')) {
        const fields = document.createElement('div');
        fields.className = 'action-fields';
        const carrier = document.createElement('input');
        carrier.placeholder = 'Carrier';
        carrier.setAttribute('aria-label', `Carrier for ${transfer.transferNumber}`);
        const tracking = document.createElement('input');
        tracking.placeholder = 'Tracking number';
        tracking.setAttribute('aria-label', `Tracking number for ${transfer.transferNumber}`);
        fields.append(carrier, tracking);
        actions.append(fields, actionButton('Dispatch', () => runWorkspaceAction(
          `/api/v1/staff/transfers/${encodeURIComponent(transfer.id)}/dispatch`,
          { method: 'POST', body: { carrier: carrier.value, trackingNumber: tracking.value } },
          `${transfer.transferNumber} is in transit.`
        )));
      }
      if (transfer.status === 'in_transit' && permission('transfers.receive')) {
        actions.append(actionButton('Receive', () => runWorkspaceAction(
          `/api/v1/staff/transfers/${encodeURIComponent(transfer.id)}/receive`, { method: 'POST' }, `${transfer.transferNumber} was received.`
        )));
      }
      card.append(copy, items, shipping, actions);
      list.append(card);
    });
  };

  const renderOrders = () => {
    const list = qs('[data-staff-orders]');
    list.replaceChildren();
    if (!permission('orders.view') || !workspace.orders.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = permission('orders.view') ? 'No paid orders are ready.' : 'Order access is not assigned to this role.';
      list.append(empty);
      return;
    }
    workspace.orders.forEach((order) => {
      const card = document.createElement('article');
      card.className = 'order-card';
      const copy = document.createElement('div');
      const title = document.createElement('h3');
      title.textContent = order.orderNumber;
      const product = document.createElement('p');
      product.textContent = `${order.quantity} x ${order.formatName} | ${order.sku}`;
      copy.append(title, product, makeStatus(order.fulfillmentStatus));
      const customer = document.createElement('div');
      customer.className = 'order-customer';
      const name = document.createElement('strong');
      name.textContent = order.customer?.name || 'Customer';
      const email = document.createElement('a');
      email.href = `mailto:${order.customer?.email || ''}`;
      email.textContent = order.customer?.email || 'Email unavailable';
      customer.append(name, email);
      if (order.shipping?.address) {
        const address = document.createElement('div');
        address.className = 'order-address';
        address.textContent = [order.shipping.address.line1, order.shipping.address.line2, order.shipping.address.city, order.shipping.address.state, order.shipping.address.postalCode, order.shipping.address.country].filter(Boolean).join(', ');
        customer.append(address);
      }
      const detail = document.createElement('div');
      detail.className = 'order-customer';
      const detailTitle = document.createElement('strong');
      detailTitle.textContent = order.amountTotal !== undefined ? formatMoney(order.amountTotal, order.currency) : 'Fulfillment';
      const detailText = document.createElement('span');
      detailText.textContent = order.trackingNumber ? `${order.carrier} | ${order.trackingNumber}` : `Paid ${formatDate(order.createdAt)}`;
      detail.append(detailTitle, detailText);
      const actions = document.createElement('div');
      actions.className = 'order-actions';
      if (permission('orders.fulfill')) {
        const next = { unfulfilled: 'picking', picking: 'packed', shipped: 'delivered' }[order.fulfillmentStatus];
        if (next) {
          actions.append(actionButton(next === 'picking' ? 'Start picking' : next === 'packed' ? 'Mark packed' : 'Mark delivered', () => runWorkspaceAction(
            `/api/v1/staff/orders/${encodeURIComponent(order.id)}/fulfillment`,
            { method: 'PATCH', body: { status: next, assignedTo: workspace.user.id } },
            `${order.orderNumber} moved to ${statusLabel(next)}.`
          )));
        }
        if (order.fulfillmentStatus === 'packed') {
          const shipForm = document.createElement('form');
          shipForm.className = 'ship-form';
          const carrierLabel = document.createElement('label');
          const carrierText = document.createElement('span');
          carrierText.textContent = 'Carrier';
          const carrier = document.createElement('input');
          carrier.required = true;
          carrierLabel.append(carrierText, carrier);
          const trackingLabel = document.createElement('label');
          const trackingText = document.createElement('span');
          trackingText.textContent = 'Tracking';
          const tracking = document.createElement('input');
          tracking.required = true;
          trackingLabel.append(trackingText, tracking);
          const submit = document.createElement('button');
          submit.type = 'submit';
          submit.textContent = 'Ship';
          shipForm.append(carrierLabel, trackingLabel, submit);
          shipForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            submit.disabled = true;
            try {
              await runWorkspaceAction(`/api/v1/staff/orders/${encodeURIComponent(order.id)}/fulfillment`, {
                method: 'PATCH', body: { status: 'shipped', assignedTo: workspace.user.id, carrier: carrier.value, trackingNumber: tracking.value }
              }, `${order.orderNumber} was marked shipped.`);
            } catch (error) { setStatus(workspaceStatus, error.message, true); } finally { submit.disabled = false; }
          });
          actions.append(shipForm);
        }
        if (['shipped', 'delivered'].includes(order.fulfillmentStatus)) {
          actions.append(actionButton('Record return', () => runWorkspaceAction(
            `/api/v1/staff/orders/${encodeURIComponent(order.id)}/fulfillment`,
            { method: 'PATCH', body: { status: 'returned', assignedTo: workspace.user.id } },
            `${order.orderNumber} was marked returned.`
          ), true));
        }
      }
      card.append(copy, customer, detail, actions);
      list.append(card);
    });
  };

  const renderFinance = () => {
    const panel = qs('[data-staff-finance]');
    panel.replaceChildren();
    if (!workspace.finance) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Financial access is not assigned to this role.';
      panel.append(empty);
      return;
    }
    if (!workspace.finance.totals.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Financial totals will appear after the first completed payment.';
      panel.append(empty);
      return;
    }
    workspace.finance.totals.forEach((total) => {
      [['Gross sales', total.grossSales], ['Shipping', total.shippingRevenue], ['Refunds', total.refunds], ['Net collected', total.netCollected]].forEach(([label, amount]) => {
        const card = document.createElement('article');
        const name = document.createElement('span');
        name.textContent = `${label} | ${total.currency}`;
        const value = document.createElement('b');
        value.textContent = formatMoney(amount, total.currency);
        card.append(name, value);
        panel.append(card);
      });
    });
  };

  const renderAudit = () => {
    const list = qs('[data-audit-list]');
    list.replaceChildren();
    if (!permission('audit.view') || !workspace.audit.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = permission('audit.view') ? 'No staff activity has been recorded yet.' : 'Audit access is not assigned to this role.';
      list.append(empty);
      return;
    }
    workspace.audit.forEach((record) => {
      const row = document.createElement('article');
      row.className = 'audit-row';
      const copy = document.createElement('div');
      copy.className = 'audit-copy';
      const action = document.createElement('strong');
      action.textContent = record.summary || statusLabel(record.action);
      const entity = document.createElement('span');
      entity.textContent = `${statusLabel(record.entityType)} | ${record.entityId}`;
      copy.append(action, entity);
      const actor = document.createElement('div');
      actor.className = 'audit-meta';
      const actorName = document.createElement('strong');
      actorName.textContent = record.actorName;
      const actorRole = document.createElement('span');
      actorRole.textContent = statusLabel(record.actorRole);
      actor.append(actorName, actorRole);
      const time = document.createElement('div');
      time.className = 'audit-meta';
      const location = document.createElement('strong');
      location.textContent = record.location ? record.location.split(',').map(locationLabel).join(', ') : 'System';
      const date = document.createElement('span');
      date.textContent = formatDate(record.createdAt);
      time.append(location, date);
      row.append(copy, actor, time);
      list.append(row);
    });
  };

  const renderContacts = () => {
    const status = qs('[data-whatsapp-status]');
    status.textContent = workspace.whatsapp?.configured ? 'WhatsApp notifications active' : 'WhatsApp click-to-chat ready';
    status.className = `source-badge${workspace.whatsapp?.configured ? '' : ' is-warning'}`;
    const list = qs('[data-contact-list]');
    list.replaceChildren();
    const managerById = new Map(workspace.directory.map((person) => [person.id, person.name]));
    const contacts = [
      ...(workspace.adminContact?.email || workspace.adminContact?.phone || workspace.adminContact?.whatsappNumber ? [{ ...workspace.adminContact, isAdmin: true }] : []),
      ...workspace.directory
    ];
    if (!contacts.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No employee contacts are available yet.';
      list.append(empty);
      return;
    }
    contacts.forEach((person) => {
      const card = document.createElement('article');
      card.className = 'contact-card';
      const portrait = document.createElement('div');
      portrait.className = 'contact-portrait';
      if (person.profilePhotoUrl) {
        const img = document.createElement('img');
        img.src = person.profilePhotoUrl;
        img.alt = `${person.name} profile`;
        portrait.append(img);
      } else {
        portrait.textContent = person.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
      }
      const copy = document.createElement('div');
      const role = document.createElement('small');
      role.textContent = person.isAdmin ? 'Administration' : person.roleLabel;
      const name = document.createElement('h3');
      name.textContent = person.name;
      const title = document.createElement('p');
      title.textContent = [person.jobTitle, person.managerId ? `Manager: ${managerById.get(person.managerId) || 'Assigned manager'}` : ''].filter(Boolean).join(' · ') || 'SEVEN ROOTS team';
      copy.append(role, name, title);
      const links = document.createElement('div');
      links.className = 'contact-actions';
      if (person.email) {
        const email = document.createElement('a');
        email.href = `mailto:${person.email}`;
        email.textContent = person.email;
        links.append(email);
      }
      if (person.phone) {
        const phone = document.createElement('a');
        phone.href = `tel:${person.phone}`;
        phone.textContent = person.phone;
        links.append(phone);
      }
      const waUrl = whatsappUrl(person.whatsappNumber, `Hello ${person.name}, this is a SEVEN ROOTS operations message.`);
      if (waUrl) {
        const whatsapp = document.createElement('a');
        whatsapp.className = 'whatsapp-action';
        whatsapp.href = waUrl;
        whatsapp.target = '_blank';
        whatsapp.rel = 'noopener';
        whatsapp.textContent = 'Open WhatsApp';
        links.append(whatsapp);
      }
      card.append(portrait, copy, links);
      list.append(card);
    });
  };

  const renderProfile = () => {
    const form = qs('[data-profile-form]');
    form.elements.jobTitle.value = workspace.user.jobTitle || '';
    form.elements.phone.value = workspace.user.phone || '';
    form.elements.whatsappNumber.value = workspace.user.whatsappNumber || '';
    const photo = qs('[data-profile-photo]');
    const photoEmpty = qs('[data-profile-photo-empty]');
    photo.hidden = !workspace.user.profilePhotoUrl;
    photoEmpty.hidden = Boolean(workspace.user.profilePhotoUrl);
    if (workspace.user.profilePhotoUrl) photo.src = workspace.user.profilePhotoUrl;
    const signature = qs('[data-profile-signature]');
    const signatureEmpty = qs('[data-profile-signature-empty]');
    signature.hidden = !workspace.user.signatureUrl;
    signatureEmpty.hidden = Boolean(workspace.user.signatureUrl);
    if (workspace.user.signatureUrl) signature.src = workspace.user.signatureUrl;
    const certificate = qs('[data-onboarding-certificate]');
    certificate.replaceChildren();
    const record = workspace.onboarding;
    certificate.hidden = !(record?.user?.onboardingRequired && record.status === 'approved' && record.review);
    if (!certificate.hidden) {
      const check = document.createElement('span');
      check.className = 'certificate-check';
      check.textContent = '✓';
      const copy = document.createElement('div');
      const kicker = document.createElement('small');
      kicker.textContent = 'Approved onboarding record';
      const title = document.createElement('h3');
      title.textContent = 'Training complete. Dashboard authorized.';
      const detail = document.createElement('p');
      detail.textContent = `${record.completedModules} modules · Employee signed ${record.signedDate} · Approved by ${record.review.reviewedByName} on ${formatDate(record.review.reviewedAt)}`;
      copy.append(kicker, title, detail);
      const manager = document.createElement('div');
      manager.className = 'certificate-manager';
      if (record.review.managerPhotoUrl) {
        const managerPhoto = document.createElement('img');
        managerPhoto.src = record.review.managerPhotoUrl;
        managerPhoto.alt = `${record.review.reviewedByName} manager profile`;
        manager.append(managerPhoto);
      }
      if (record.review.managerSignatureUrl) {
        const managerSignature = document.createElement('img');
        managerSignature.className = 'certificate-signature';
        managerSignature.src = record.review.managerSignatureUrl;
        managerSignature.alt = `${record.review.reviewedByName} approval signature`;
        manager.append(managerSignature);
      }
      certificate.append(check, copy, manager);
    }
  };

  const renderOnboardingReviews = () => {
    const list = qs('[data-onboarding-review-list]');
    list.replaceChildren();
    if (!permission('onboarding.review') || !workspace.onboardingReviews?.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = permission('onboarding.review')
        ? 'No employee onboarding records are waiting or recently reviewed.'
        : 'Onboarding review is not assigned to this role.';
      list.append(empty);
      return;
    }
    workspace.onboardingReviews.forEach((record) => {
      const card = document.createElement('article');
      card.className = `onboarding-review-card is-${record.status}`;
      const employee = document.createElement('div');
      employee.className = 'onboarding-review-employee';
      const portrait = document.createElement('span');
      portrait.className = 'review-employee-photo';
      if (record.employeePhotoUrl) {
        const image = document.createElement('img');
        image.src = record.employeePhotoUrl;
        image.alt = `${record.user.name} employee profile`;
        portrait.append(image);
      } else {
        portrait.textContent = record.user.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
      }
      const identity = document.createElement('div');
      const eyebrow = document.createElement('small');
      eyebrow.textContent = `${record.user.employeeNumber} · ${record.user.roleLabel}`;
      const name = document.createElement('h3');
      name.textContent = record.user.name;
      const location = document.createElement('p');
      location.textContent = `${record.user.locations.map(locationLabel).join(' and ')} · Submitted ${formatDate(record.submittedAt)}`;
      identity.append(eyebrow, name, location);
      employee.append(portrait, identity, makeStatus(record.status));

      const recordGrid = document.createElement('dl');
      [
        ['Training', `${record.completedModules} of ${record.totalModules} modules complete`],
        ['Signed name', record.signedName || 'Not provided'],
        ['Date signed', record.signedDate || 'Not provided'],
        ['Submitted', formatDate(record.submittedAt)]
      ].forEach(([term, value]) => {
        const item = document.createElement('div');
        const dt = document.createElement('dt');
        dt.textContent = term;
        const dd = document.createElement('dd');
        dd.textContent = value;
        item.append(dt, dd);
        recordGrid.append(item);
      });

      const evidence = document.createElement('div');
      evidence.className = 'onboarding-signature-evidence';
      const employeeSignature = document.createElement('figure');
      const signatureLabel = document.createElement('figcaption');
      signatureLabel.textContent = 'Employee signature';
      employeeSignature.append(signatureLabel);
      if (record.employeeSignatureUrl) {
        const image = document.createElement('img');
        image.src = record.employeeSignatureUrl;
        image.alt = `${record.user.name} signature`;
        employeeSignature.append(image);
      }
      evidence.append(employeeSignature);

      if (record.review?.managerSignatureUrl) {
        const managerSignature = document.createElement('figure');
        managerSignature.className = 'manager-review-proof';
        const managerLabel = document.createElement('figcaption');
        managerLabel.textContent = `Reviewed by ${record.review.reviewedByName}`;
        if (record.review.managerPhotoUrl) {
          const managerPhoto = document.createElement('img');
          managerPhoto.className = 'manager-review-photo';
          managerPhoto.src = record.review.managerPhotoUrl;
          managerPhoto.alt = `${record.review.reviewedByName} manager profile`;
          managerSignature.append(managerLabel, managerPhoto);
        } else {
          managerSignature.append(managerLabel);
        }
        const image = document.createElement('img');
        image.src = record.review.managerSignatureUrl;
        image.alt = `${record.review.reviewedByName} approval signature`;
        managerSignature.append(image);
        evidence.append(managerSignature);
      }

      card.append(employee, recordGrid, evidence);
      if (record.status === 'pending_review') {
        const form = document.createElement('form');
        form.className = 'onboarding-review-form';
        const note = document.createElement('textarea');
        note.maxLength = 1200;
        note.placeholder = 'Approval note or the corrections required';
        note.setAttribute('aria-label', `Review note for ${record.user.name}`);
        const approve = document.createElement('button');
        approve.type = 'button';
        approve.textContent = 'Approve and open dashboard';
        approve.disabled = !workspace.user.profileReady;
        approve.title = workspace.user.profileReady ? '' : 'Upload your manager photo and signature in My profile first.';
        approve.addEventListener('click', async () => {
          approve.disabled = true;
          try {
            await runWorkspaceAction(`/api/v1/staff/onboarding/reviews/${encodeURIComponent(record.user.id)}`, {
              method: 'POST', body: { decision: 'approve', reviewNote: note.value }
            }, `${record.user.name}'s onboarding was approved. Dashboard access is open.`);
          } catch (error) {
            setStatus(workspaceStatus, error.message, true);
            approve.disabled = !workspace.user.profileReady;
          }
        });
        const changes = document.createElement('button');
        changes.type = 'button';
        changes.className = 'secondary';
        changes.textContent = 'Request changes';
        changes.addEventListener('click', async () => {
          changes.disabled = true;
          try {
            await runWorkspaceAction(`/api/v1/staff/onboarding/reviews/${encodeURIComponent(record.user.id)}`, {
              method: 'POST', body: { decision: 'request_changes', reviewNote: note.value }
            }, `${record.user.name}'s onboarding was returned for changes.`);
          } catch (error) {
            setStatus(workspaceStatus, error.message, true);
            changes.disabled = false;
          }
        });
        form.append(note, approve, changes);
        card.append(form);
      } else if (record.review) {
        const reviewNote = document.createElement('p');
        reviewNote.className = 'onboarding-review-note';
        reviewNote.textContent = `${record.review.reviewedByName} · ${formatDate(record.review.reviewedAt)}${record.review.note ? ` · ${record.review.note}` : ''}`;
        card.append(reviewNote);
      }
      list.append(card);
    });
  };

  const renderNavigation = () => {
    const access = {
      work: permission('tasks.view'),
      inventory: permission('inventory.view'),
      transfers: permission('transfers.view'),
      orders: permission('orders.view'),
      finance: permission('finance.view'),
      contacts: permission('directory.view'),
      onboarding: permission('onboarding.review'),
      profile: permission('profile.update'),
      audit: permission('audit.view')
    };
    qsa('[data-view]').forEach((button) => { button.hidden = !access[button.dataset.view]; });
    const current = qs('[data-view][aria-current="page"]');
    if (!current || current.hidden) {
      const first = qsa('[data-view]').find((button) => !button.hidden);
      if (first) first.click();
    }
  };

  const renderWorkspace = () => {
    qs('[data-session-identity]').textContent = `${workspace.user.name} | ${workspace.user.roleLabel}`;
    qs('[data-welcome]').textContent = `Welcome, ${workspace.user.name.split(' ')[0]}.`;
    qs('[data-location-label]').textContent = workspace.user.locations.map(locationLabel).join(' and ');
    Object.entries(workspace.summary).forEach(([key, value]) => {
      const element = qs(`[data-metric="${key}"]`);
      if (element) element.textContent = value;
    });
    renderTasks();
    renderInventory();
    renderTransfers();
    renderOrders();
    renderFinance();
    renderContacts();
    renderOnboardingReviews();
    renderProfile();
    renderAudit();
    renderNavigation();
  };

  const loadWorkspace = async () => {
    setStatus(workspaceStatus, 'Refreshing assigned work...');
    workspace = await api('/api/v1/staff/workspace');
    renderWorkspace();
    setStatus(workspaceStatus, `Updated ${new Date().toLocaleTimeString()}.`);
    accessShell.hidden = true;
    onboardingShell.hidden = true;
    operations.hidden = false;
    sessionActions.hidden = false;
  };

  qsa('[data-view]').forEach((button) => button.addEventListener('click', () => {
    qsa('[data-view]').forEach((item) => item.removeAttribute('aria-current'));
    button.setAttribute('aria-current', 'page');
    qsa('[data-workspace-view]').forEach((view) => { view.hidden = view.dataset.workspaceView !== button.dataset.view; });
  }));

  qs('[data-task-form]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const button = qs('button[type="submit"]', event.currentTarget);
    button.disabled = true;
    try {
      setStatus(workspaceStatus, 'Creating the operation and securing its work files…');
      const created = await api('/api/v1/staff/tasks', {
        method: 'POST',
        body: {
          title: form.get('title'),
          type: form.get('type'),
          location: form.get('location'),
          priority: form.get('priority'),
          assignedTo: form.get('assignedTo'),
          dueAt: form.get('dueAt') || null,
          scopeOfWork: form.get('scopeOfWork'),
          evidenceRequirements: form.getAll('evidenceRequirements').map(String)
        }
      });
      const task = created.task || created;
      const sowFiles = form.getAll('sowFiles').filter((file) => file instanceof File && file.size);
      const workFiles = form.getAll('workFiles').filter((file) => file instanceof File && file.size);
      for (const file of sowFiles) {
        setStatus(workspaceStatus, `Uploading SOW file ${file.name}…`);
        await uploadFile(`/api/v1/staff/tasks/${encodeURIComponent(task.id)}/files`, file, { kind: 'sow', phase: 'scope' });
      }
      for (const file of workFiles) {
        setStatus(workspaceStatus, `Uploading reference file ${file.name}…`);
        await uploadFile(`/api/v1/staff/tasks/${encodeURIComponent(task.id)}/files`, file, { kind: workFileKind(file), phase: 'scope' });
      }
      event.currentTarget.reset();
      await loadWorkspace();
      setStatus(workspaceStatus, `${task.title} was created${task.assignedTo ? ' and assigned' : ''}.`);
    } catch (error) { setStatus(workspaceStatus, error.message, true); } finally { button.disabled = false; }
  });

  qs('[data-onboarding-form]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const button = qs('[data-onboarding-submit-button]');
    button.disabled = true;
    try {
      setStatus(qs('[data-onboarding-message]'), 'Securing your employee photo and signature…');
      const photo = form.get('profilePhoto');
      if (photo instanceof File && photo.size) await uploadFile('/api/v1/staff/profile/files/profile_photo', photo);
      const signature = form.get('signature');
      if (signature instanceof File && signature.size) await uploadFile('/api/v1/staff/profile/files/signature', signature);
      onboarding = await api('/api/v1/staff/onboarding/submit', {
        method: 'POST',
        body: {
          signedName: form.get('signedName'),
          signedDate: form.get('signedDate'),
          acknowledgments: form.getAll('acknowledgments').map(String)
        }
      });
      formElement.elements.profilePhoto.value = '';
      formElement.elements.signature.value = '';
      renderOnboarding();
      setStatus(qs('[data-onboarding-message]'), 'Your signed onboarding record was sent to management. Dashboard access remains locked until approval.');
    } catch (error) {
      setStatus(qs('[data-onboarding-message]'), error.message, true);
      button.disabled = onboarding?.completedModules !== onboarding?.totalModules;
    }
  });

  qs('[data-profile-form]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const button = qs('button[type="submit"]', formElement);
    button.disabled = true;
    try {
      setStatus(workspaceStatus, 'Saving your contact and approval profile…');
      await api('/api/v1/staff/profile', {
        method: 'PATCH',
        body: { jobTitle: form.get('jobTitle'), phone: form.get('phone'), whatsappNumber: form.get('whatsappNumber') }
      });
      const photo = form.get('profilePhoto');
      if (photo instanceof File && photo.size) await uploadFile('/api/v1/staff/profile/files/profile_photo', photo);
      const signature = form.get('signature');
      if (signature instanceof File && signature.size) await uploadFile('/api/v1/staff/profile/files/signature', signature);
      formElement.elements.profilePhoto.value = '';
      formElement.elements.signature.value = '';
      await loadWorkspace();
      setStatus(workspaceStatus, 'Your contact and approval profile is up to date.');
    } catch (error) { setStatus(workspaceStatus, error.message, true); } finally { button.disabled = false; }
  });

  qs('[data-transfer-form]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const items = ['travel-sleeve', 'daily-ritual', 'family-reserve']
      .map((formatSlug) => ({ formatSlug, quantity: Number(form.get(formatSlug)) }))
      .filter((item) => Number.isInteger(item.quantity) && item.quantity > 0);
    const button = qs('button[type="submit"]', event.currentTarget);
    button.disabled = true;
    try {
      await runWorkspaceAction('/api/v1/staff/transfers', {
        method: 'POST', body: { fromLocation: 'liberia', toLocation: 'us', items, freightReference: form.get('freightReference'), notes: form.get('notes') }
      }, 'Transfer draft created.');
      event.currentTarget.reset();
    } catch (error) { setStatus(workspaceStatus, error.message, true); } finally { button.disabled = false; }
  });

  const loadAuthenticatedExperience = async () => {
    onboarding = await api('/api/v1/staff/onboarding');
    if (onboarding.dashboardAccess) {
      await loadWorkspace();
      return;
    }
    renderOnboarding();
  };

  const establishSession = async (data) => {
    csrfToken = data.csrfToken;
    sessionStorage.setItem(csrfStorageKey, csrfToken);
    if (data.user?.passwordChangeRequired) {
      operations.hidden = true;
      onboardingShell.hidden = true;
      sessionActions.hidden = false;
      qs('[data-refresh]').hidden = true;
      qs('[data-session-identity]').textContent = `${data.user.name} | Password update`;
      showAccessForm(passwordChangeForm);
      return;
    }
    qs('[data-refresh]').hidden = false;
    await loadAuthenticatedExperience();
  };

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const button = qs('button[type="submit"]', event.currentTarget);
    button.disabled = true;
    setStatus(qs('[data-login-status]'), 'Verifying staff access...');
    try {
      await establishSession(await api('/api/v1/staff/auth/login', { method: 'POST', body: { email: form.get('email'), password: form.get('password') } }));
      event.currentTarget.reset();
    } catch (error) { setStatus(qs('[data-login-status]'), error.message, true); } finally { button.disabled = false; }
  });

  qs('[data-show-temporary-password]').addEventListener('click', () => {
    setStatus(qs('[data-login-status]'), '');
    showAccessForm(temporaryPasswordForm);
    temporaryPasswordForm.elements.email.focus();
  });

  qsa('[data-return-login]').forEach((button) => button.addEventListener('click', () => {
    showAccessForm(loginForm);
    loginForm.elements.email.focus();
  }));

  temporaryPasswordForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const button = qs('button[type="submit"]', event.currentTarget);
    button.disabled = true;
    setStatus(qs('[data-temporary-password-status]'), 'Requesting a secure temporary password...');
    try {
      await api('/api/v1/staff/auth/temporary-password/request', {
        method: 'POST', body: { email: form.get('email') }
      });
      setStatus(qs('[data-temporary-password-status]'), 'Check your email. If this address matches an active staff account, we sent a one-time temporary password. Also check your spam folder.');
    } catch (error) {
      setStatus(qs('[data-temporary-password-status]'), error.message, true);
    } finally { button.disabled = false; }
  });

  passwordChangeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const button = qs('button[type="submit"]', event.currentTarget);
    if (form.get('password') !== form.get('confirmation')) {
      setStatus(qs('[data-password-change-status]'), 'The password confirmation does not match.', true);
      return;
    }
    button.disabled = true;
    setStatus(qs('[data-password-change-status]'), 'Securing your private staff password...');
    try {
      await establishSession(await api('/api/v1/staff/auth/change-password', {
        method: 'POST', body: { password: form.get('password') }
      }));
      event.currentTarget.reset();
    } catch (error) {
      const detail = Object.values(error.details || {})[0];
      setStatus(qs('[data-password-change-status]'), detail || error.message, true);
    } finally { button.disabled = false; }
  });

  inviteForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const button = qs('button[type="submit"]', event.currentTarget);
    if (form.get('password') !== form.get('confirmation')) {
      setStatus(qs('[data-invite-status]'), 'The password confirmation does not match.', true);
      return;
    }
    button.disabled = true;
    setStatus(qs('[data-invite-status]'), 'Activating your staff account...');
    try {
      await establishSession(await api('/api/v1/staff/auth/accept-invite', { method: 'POST', body: { token: form.get('token'), password: form.get('password') } }));
      history.replaceState({}, document.title, '/staff');
    } catch (error) {
      const detail = Object.values(error.details || {})[0];
      setStatus(qs('[data-invite-status]'), detail || error.message, true);
    } finally { button.disabled = false; }
  });

  qs('[data-refresh]').addEventListener('click', () => loadAuthenticatedExperience().catch((error) => {
    const target = onboardingShell.hidden ? workspaceStatus : qs('[data-onboarding-message]');
    setStatus(target, error.message, true);
  }));
  const signOut = async () => {
    try { await api('/api/v1/staff/auth/logout', { method: 'POST', body: {} }); } catch {}
    csrfToken = '';
    sessionStorage.removeItem(csrfStorageKey);
    workspace = null;
    onboarding = null;
    activeTrainingModuleId = '';
    operations.hidden = true;
    onboardingShell.hidden = true;
    sessionActions.hidden = true;
    qs('[data-refresh]').hidden = false;
    showAccessForm(loginForm);
    history.replaceState({}, document.title, '/staff');
  };
  qs('[data-sign-out]').addEventListener('click', signOut);
  qs('[data-password-change-sign-out]').addEventListener('click', signOut);

  const invitationToken = new URLSearchParams(location.search).get('invite');
  if (invitationToken) {
    inviteForm.elements.token.value = invitationToken;
    history.replaceState({}, document.title, '/staff');
    showAccessForm(inviteForm);
  } else {
    api('/api/v1/staff/auth/session')
      .then((data) => establishSession(data))
      .catch(() => {
        csrfToken = '';
        sessionStorage.removeItem(csrfStorageKey);
      });
  }
})();
