// SPDX-License-Identifier: MIT

export const ROLE_APPLICATION_API_ROUTE = '/api/role-applications' as const;

export type ContributorRoleApplicationRoleId = 'research-contributor' | 'governance-contributor';

export interface ContributorRoleCatalogEntry {
  readonly roleId: ContributorRoleApplicationRoleId;
  readonly label: string;
  readonly lane: 'research' | 'governance';
}

export const CONTRIBUTOR_ROLE_APPLICATION_CATALOG: Readonly<Record<ContributorRoleApplicationRoleId, ContributorRoleCatalogEntry>> = Object.freeze({
  'research-contributor': Object.freeze({
    roleId: 'research-contributor',
    label: 'Research contributor',
    lane: 'research',
  }),
  'governance-contributor': Object.freeze({
    roleId: 'governance-contributor',
    label: 'Governance contributor',
    lane: 'governance',
  }),
});

export type RoleApplicationFieldId = 'roleId' | 'motivation' | 'experience' | 'evidenceUrls' | 'consentToReview';

export interface RoleApplicationFieldAccessibility {
  readonly controlId: string;
  readonly labelId: string;
  readonly descriptionId: string;
  readonly errorId: string;
  readonly describedBy: readonly string[];
  readonly ariaRequired: boolean;
  readonly ariaInvalidWhenError: boolean;
  readonly errorMessage: string;
}

export interface RoleApplicationFieldMobileBehavior {
  readonly layout: 'single-column' | 'multi-column';
  readonly fullWidth: boolean;
  readonly minViewportWidthPx: number;
  readonly minTouchTargetPx: number;
  readonly preservesPinchZoom: boolean;
  readonly avoidsKeyboardObstruction: boolean;
}

export interface RoleApplicationFieldContract {
  readonly id: RoleApplicationFieldId;
  readonly name: string;
  readonly control: 'select' | 'textarea' | 'url-list' | 'checkbox';
  readonly label: string;
  readonly description: string;
  readonly required: boolean;
  readonly autocomplete?: 'off' | 'url';
  readonly inputMode?: 'text' | 'url';
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly maxItems?: number;
  readonly options?: readonly ContributorRoleApplicationRoleId[];
  readonly accessibility: RoleApplicationFieldAccessibility;
  readonly mobile: RoleApplicationFieldMobileBehavior;
}

export interface RoleApplicationErrorSummaryContract {
  readonly containerId: string;
  readonly headingId: string;
  readonly role: 'alert' | 'status' | 'none';
  readonly tabIndex: number;
  readonly focusOnValidationFailure: boolean;
}

export interface RoleApplicationSubmitContract {
  readonly label: string;
  readonly type: 'submit';
  readonly minTouchTargetPx: number;
  readonly placement: 'after-fields' | 'before-fields' | 'sticky-overlay';
  readonly respectsSafeAreaInset: boolean;
}

export interface RoleApplicationViewportContract {
  readonly width: 'device-width';
  readonly initialScale: 1;
  readonly userScalable: boolean;
}

export interface RoleApplicationFormContract {
  readonly route: string;
  readonly method: 'POST' | 'GET' | 'PUT' | 'PATCH';
  readonly encoding: string;
  readonly title: string;
  readonly minViewportWidthPx: number;
  readonly mobileSingleColumnUntilPx: number;
  readonly viewport: RoleApplicationViewportContract;
  readonly errorSummary: RoleApplicationErrorSummaryContract;
  readonly fields: readonly RoleApplicationFieldContract[];
  readonly submit: RoleApplicationSubmitContract;
}

export interface RoleApplicationQualityIssue {
  readonly path: string;
  readonly message: string;
}

export interface ContributorRoleApplicationDraft {
  readonly roleId?: unknown;
  readonly motivation?: unknown;
  readonly experience?: unknown;
  readonly evidenceUrls?: unknown;
  readonly consentToReview?: unknown;
  readonly [key: string]: unknown;
}

export interface NormalizedContributorRoleApplication {
  readonly roleId: ContributorRoleApplicationRoleId;
  readonly lane: ContributorRoleCatalogEntry['lane'];
  readonly motivation: string;
  readonly experience: string;
  readonly evidenceUrls: readonly string[];
  readonly consentToReview: true;
}

export interface ContributorRoleApplicationFieldError {
  readonly field: RoleApplicationFieldId | 'form';
  readonly message: string;
}

export type ContributorRoleApplicationDraftValidation =
  | {
      readonly ok: true;
      readonly value: NormalizedContributorRoleApplication;
    }
  | {
      readonly ok: false;
      readonly errors: readonly ContributorRoleApplicationFieldError[];
    };

export interface ContributorRoleApplicationErrorState {
  readonly summary: {
    readonly role: RoleApplicationErrorSummaryContract['role'];
    readonly tabIndex: number;
    readonly focusTargetId: string;
    readonly links: readonly Readonly<{ field: RoleApplicationFieldId; href: string; message: string }>[];
  };
  readonly fields: Readonly<Record<RoleApplicationFieldId, Readonly<{
    ariaInvalid: boolean;
    ariaDescribedBy: string;
    errorId: string;
    errorMessage: string | null;
  }>>>;
}

const MOBILE_MIN_VIEWPORT_PX = 320;
const MOBILE_SINGLE_COLUMN_UNTIL_PX = 640;
const MIN_TOUCH_TARGET_PX = 44;
const DISALLOWED_CLIENT_AUTHORITY_FIELDS = new Set([
  'applicantId',
  'applicant_id',
  'wallet',
  'reviewer',
  'reviewer_id',
  'authority',
  'authorityScope',
  'lane',
  'capabilityGrant',
]);

function field(
  id: RoleApplicationFieldId,
  input: Omit<RoleApplicationFieldContract, 'id' | 'name' | 'accessibility' | 'mobile'>,
): RoleApplicationFieldContract {
  const controlId = `role-application-${id}`;
  const descriptionId = `${controlId}-description`;
  const errorId = `${controlId}-error`;
  return Object.freeze({
    id,
    name: id,
    ...input,
    accessibility: Object.freeze({
      controlId,
      labelId: `${controlId}-label`,
      descriptionId,
      errorId,
      describedBy: Object.freeze([descriptionId, errorId]),
      ariaRequired: input.required,
      ariaInvalidWhenError: true,
      errorMessage: defaultErrorMessage(id),
    }),
    mobile: Object.freeze({
      layout: 'single-column',
      fullWidth: true,
      minViewportWidthPx: MOBILE_MIN_VIEWPORT_PX,
      minTouchTargetPx: MIN_TOUCH_TARGET_PX,
      preservesPinchZoom: true,
      avoidsKeyboardObstruction: true,
    }),
  });
}

function defaultErrorMessage(id: RoleApplicationFieldId): string {
  switch (id) {
    case 'roleId':
      return 'Choose a contributor role.';
    case 'motivation':
      return 'Describe why this role is a fit.';
    case 'experience':
      return 'Describe relevant experience.';
    case 'evidenceUrls':
      return 'Add at least one HTTP or HTTPS evidence link.';
    case 'consentToReview':
      return 'Confirm that the application can be reviewed.';
  }
}

export function contributorRoleApplicationFormContract(): RoleApplicationFormContract {
  return Object.freeze({
    route: ROLE_APPLICATION_API_ROUTE,
    method: 'POST',
    encoding: 'application/json',
    title: 'Contributor role application',
    minViewportWidthPx: MOBILE_MIN_VIEWPORT_PX,
    mobileSingleColumnUntilPx: MOBILE_SINGLE_COLUMN_UNTIL_PX,
    viewport: Object.freeze({
      width: 'device-width',
      initialScale: 1,
      userScalable: true,
    }),
    errorSummary: Object.freeze({
      containerId: 'role-application-errors',
      headingId: 'role-application-errors-heading',
      role: 'alert',
      tabIndex: -1,
      focusOnValidationFailure: true,
    }),
    fields: Object.freeze([
      field('roleId', {
        control: 'select',
        label: 'Contributor role',
        description: 'Choose the server-registered Bittrees role you are applying for.',
        required: true,
        autocomplete: 'off',
        options: Object.freeze(['research-contributor', 'governance-contributor']),
      }),
      field('motivation', {
        control: 'textarea',
        label: 'Motivation',
        description: 'Explain the contribution you want to make and the outcome you can support.',
        required: true,
        autocomplete: 'off',
        inputMode: 'text',
        minLength: 80,
        maxLength: 2000,
      }),
      field('experience', {
        control: 'textarea',
        label: 'Relevant experience',
        description: 'Summarize prior work, research, governance, or operational experience relevant to this role.',
        required: true,
        autocomplete: 'off',
        inputMode: 'text',
        minLength: 40,
        maxLength: 2000,
      }),
      field('evidenceUrls', {
        control: 'url-list',
        label: 'Evidence links',
        description: 'Add one to five HTTP or HTTPS links that support the application.',
        required: true,
        autocomplete: 'url',
        inputMode: 'url',
        maxItems: 5,
      }),
      field('consentToReview', {
        control: 'checkbox',
        label: 'I understand this application will be reviewed before any contributor capability is granted.',
        description: 'Approval is only a review outcome; it does not grant tools, repositories, wallet access, or execution authority.',
        required: true,
        autocomplete: 'off',
      }),
    ]),
    submit: Object.freeze({
      label: 'Submit application',
      type: 'submit',
      minTouchTargetPx: MIN_TOUCH_TARGET_PX,
      placement: 'after-fields',
      respectsSafeAreaInset: true,
    }),
  });
}

export function validateContributorRoleApplicationFormQualityGates(
  form: RoleApplicationFormContract,
): RoleApplicationQualityIssue[] {
  const issues: RoleApplicationQualityIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  const seenIds = new Set<string>();
  const fieldIds = new Set<RoleApplicationFieldId>();

  if (form.route !== ROLE_APPLICATION_API_ROUTE) add('route', `route must remain ${ROLE_APPLICATION_API_ROUTE}`);
  if (form.method !== 'POST') add('method', 'application form must submit with POST');
  if (form.encoding !== 'application/json') add('encoding', 'application form must submit JSON');
  if (!form.title.trim()) add('title', 'form must have an accessible name');
  if (form.minViewportWidthPx > MOBILE_MIN_VIEWPORT_PX) add('minViewportWidthPx', 'mobile layout must support 320px viewports');
  if (form.mobileSingleColumnUntilPx < 480) add('mobileSingleColumnUntilPx', 'mobile layout must stay single-column through at least 480px');
  if (form.viewport.width !== 'device-width' || form.viewport.initialScale !== 1 || form.viewport.userScalable !== true) {
    add('viewport', 'viewport must use device width, initial scale 1, and preserve user zoom');
  }
  if (form.errorSummary.role !== 'alert' || form.errorSummary.tabIndex !== -1 || form.errorSummary.focusOnValidationFailure !== true) {
    add('errorSummary', 'validation errors must be announced and programmatically focusable');
  }
  if (form.submit.minTouchTargetPx < MIN_TOUCH_TARGET_PX) add('submit.minTouchTargetPx', 'submit touch target must be at least 44px');
  if (form.submit.placement !== 'after-fields') add('submit.placement', 'submit must follow the fields in source and focus order');
  if (form.submit.respectsSafeAreaInset !== true) add('submit.respectsSafeAreaInset', 'submit must respect mobile safe-area insets');

  for (const required of ['roleId', 'motivation', 'experience', 'evidenceUrls', 'consentToReview'] as const) {
    if (!form.fields.some(candidate => candidate.id === required)) add(`fields.${required}`, 'required application field is missing');
  }

  form.fields.forEach((candidate, index) => {
    const path = `fields[${index}]`;
    fieldIds.add(candidate.id);
    if (!candidate.name) add(`${path}.name`, 'field must have a stable submit name');
    if (!candidate.label.trim()) add(`${path}.label`, 'field must have a visible label');
    if (candidate.label.trim() === candidate.description.trim()) add(`${path}.label`, 'label must not be placeholder-style helper text');
    if (!candidate.description.trim()) add(`${path}.description`, 'field must have helper text');
    if (candidate.required !== true) add(`${path}.required`, 'application fields are required before submission');
    if (candidate.mobile.layout !== 'single-column' || candidate.mobile.fullWidth !== true) {
      add(`${path}.mobile.layout`, 'mobile fields must render full-width in a single column');
    }
    if (candidate.mobile.minViewportWidthPx > MOBILE_MIN_VIEWPORT_PX) {
      add(`${path}.mobile.minViewportWidthPx`, 'field must fit a 320px viewport');
    }
    if (candidate.mobile.minTouchTargetPx < MIN_TOUCH_TARGET_PX) {
      add(`${path}.mobile.minTouchTargetPx`, 'field touch target must be at least 44px');
    }
    if (candidate.mobile.preservesPinchZoom !== true) add(`${path}.mobile.preservesPinchZoom`, 'field must preserve mobile zoom');
    if (candidate.mobile.avoidsKeyboardObstruction !== true) {
      add(`${path}.mobile.avoidsKeyboardObstruction`, 'field must remain visible when the mobile keyboard is open');
    }

    const a11y = candidate.accessibility;
    for (const [name, id] of Object.entries({
      controlId: a11y.controlId,
      labelId: a11y.labelId,
      descriptionId: a11y.descriptionId,
      errorId: a11y.errorId,
    })) {
      if (!id.trim()) add(`${path}.accessibility.${name}`, 'accessibility id is required');
      if (seenIds.has(id)) add(`${path}.accessibility.${name}`, `duplicate accessibility id ${id}`);
      seenIds.add(id);
    }
    if (!a11y.describedBy.includes(a11y.descriptionId) || !a11y.describedBy.includes(a11y.errorId)) {
      add(`${path}.accessibility.describedBy`, 'field must describe helper and error text');
    }
    if (a11y.ariaRequired !== true) add(`${path}.accessibility.ariaRequired`, 'required field must expose aria-required');
    if (a11y.ariaInvalidWhenError !== true) {
      add(`${path}.accessibility.ariaInvalidWhenError`, 'field must expose aria-invalid when validation fails');
    }
    if (!a11y.errorMessage.trim()) add(`${path}.accessibility.errorMessage`, 'field must have an accessible error message');

    if (candidate.id === 'roleId') {
      const options = candidate.options ?? [];
      for (const roleId of Object.keys(CONTRIBUTOR_ROLE_APPLICATION_CATALOG) as ContributorRoleApplicationRoleId[]) {
        if (!options.includes(roleId)) add(`${path}.options`, `missing registered role ${roleId}`);
      }
    }
    if (candidate.id === 'evidenceUrls') {
      if (candidate.inputMode !== 'url' || candidate.autocomplete !== 'url') {
        add(`${path}.inputMode`, 'evidence field must use URL mobile keyboard hints');
      }
      if ((candidate.maxItems ?? 0) > 5 || (candidate.maxItems ?? 0) < 1) {
        add(`${path}.maxItems`, 'evidence links must be bounded to one through five URLs');
      }
    }
    if ((candidate.id === 'motivation' || candidate.id === 'experience') &&
        (!candidate.minLength || !candidate.maxLength || candidate.maxLength > 2000)) {
      add(`${path}.maxLength`, 'long text fields must have bounded lengths');
    }
  });

  if (fieldIds.size !== form.fields.length) add('fields', 'field ids must be unique');
  return issues;
}

export function validateContributorRoleApplicationDraft(
  input: unknown,
): ContributorRoleApplicationDraftValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: Object.freeze([{ field: 'form', message: 'Application must be an object.' }]) };
  }

  const draft = input as ContributorRoleApplicationDraft;
  const errors: ContributorRoleApplicationFieldError[] = [];
  for (const key of Object.keys(draft)) {
    if (DISALLOWED_CLIENT_AUTHORITY_FIELDS.has(key)) {
      errors.push({ field: 'form', message: `Do not submit server-derived authority field "${key}".` });
    }
  }

  const roleId = typeof draft.roleId === 'string' ? draft.roleId.trim() : '';
  const role = CONTRIBUTOR_ROLE_APPLICATION_CATALOG[roleId as ContributorRoleApplicationRoleId];
  if (!role) errors.push({ field: 'roleId', message: defaultErrorMessage('roleId') });

  const motivation = boundedText(draft.motivation, 80, 2000);
  if (!motivation) errors.push({ field: 'motivation', message: defaultErrorMessage('motivation') });

  const experience = boundedText(draft.experience, 40, 2000);
  if (!experience) errors.push({ field: 'experience', message: defaultErrorMessage('experience') });

  const evidenceUrls = normalizeEvidenceUrls(draft.evidenceUrls);
  if (evidenceUrls.length === 0) errors.push({ field: 'evidenceUrls', message: defaultErrorMessage('evidenceUrls') });

  if (draft.consentToReview !== true) {
    errors.push({ field: 'consentToReview', message: defaultErrorMessage('consentToReview') });
  }

  if (errors.length > 0 || !role || !motivation || !experience || draft.consentToReview !== true) {
    return { ok: false, errors: Object.freeze(errors) };
  }

  return {
    ok: true,
    value: Object.freeze({
      roleId: role.roleId,
      lane: role.lane,
      motivation,
      experience,
      evidenceUrls: Object.freeze(evidenceUrls),
      consentToReview: true,
    }),
  };
}

export function buildContributorRoleApplicationErrorState(
  errors: readonly ContributorRoleApplicationFieldError[],
  form: RoleApplicationFormContract = contributorRoleApplicationFormContract(),
): ContributorRoleApplicationErrorState {
  const fields = Object.fromEntries(form.fields.map(candidate => {
    const error = errors.find(item => item.field === candidate.id) ?? null;
    return [candidate.id, Object.freeze({
      ariaInvalid: Boolean(error),
      ariaDescribedBy: candidate.accessibility.describedBy.join(' '),
      errorId: candidate.accessibility.errorId,
      errorMessage: error?.message ?? null,
    })];
  })) as Record<RoleApplicationFieldId, {
    ariaInvalid: boolean;
    ariaDescribedBy: string;
    errorId: string;
    errorMessage: string | null;
  }>;

  const links = errors
    .filter((error): error is ContributorRoleApplicationFieldError & { field: RoleApplicationFieldId } => error.field !== 'form')
    .map(error => {
      const contract = form.fields.find(candidate => candidate.id === error.field);
      return Object.freeze({
        field: error.field,
        href: `#${contract?.accessibility.controlId ?? error.field}`,
        message: error.message,
      });
    });

  return Object.freeze({
    summary: Object.freeze({
      role: form.errorSummary.role,
      tabIndex: form.errorSummary.tabIndex,
      focusTargetId: form.errorSummary.containerId,
      links: Object.freeze(links),
    }),
    fields: Object.freeze(fields),
  });
}

function boundedText(value: unknown, minLength: number, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length < minLength || normalized.length > maxLength) return null;
  return normalized;
}

function normalizeEvidenceUrls(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) return [];
  const urls: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return [];
    const trimmed = item.trim();
    if (trimmed.length > 300) return [];
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return [];
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return [];
    urls.push(parsed.toString());
  }
  return urls;
}
