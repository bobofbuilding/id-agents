// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
  ROLE_APPLICATION_API_ROUTE,
  buildContributorRoleApplicationErrorState,
  contributorRoleApplicationFormContract,
  validateContributorRoleApplicationDraft,
  validateContributorRoleApplicationFormQualityGates,
  type RoleApplicationFormContract,
} from '../../src/contributor-signing/index.js';

const validMotivation = 'I want to support Bittrees research operations with careful source review, repeatable evidence capture, and concise contributor-facing reports.';
const validExperience = 'I have written comparable research notes, reviewed governance processes, and maintained regression-focused project documentation.';

function withFormOverride(overrides: Partial<RoleApplicationFormContract>): RoleApplicationFormContract {
  return {
    ...contributorRoleApplicationFormContract(),
    ...overrides,
  };
}

describe('contributor role application mobile accessibility quality gates', () => {
  it('ships a form contract that passes acceptance-critical mobile and accessibility gates', () => {
    const form = contributorRoleApplicationFormContract();

    expect(form.route).toBe(ROLE_APPLICATION_API_ROUTE);
    expect(validateContributorRoleApplicationFormQualityGates(form)).toEqual([]);
    expect(form.fields.map(field => field.id)).toEqual([
      'roleId',
      'motivation',
      'experience',
      'evidenceUrls',
      'consentToReview',
    ]);
  });

  it('regresses when a mobile field loses a visible label, error wiring, or 44px touch target', () => {
    const form = contributorRoleApplicationFormContract();
    const broken = withFormOverride({
      fields: [
        {
          ...form.fields[0],
          label: '',
          accessibility: {
            ...form.fields[0].accessibility,
            describedBy: [form.fields[0].accessibility.descriptionId],
          },
          mobile: {
            ...form.fields[0].mobile,
            minTouchTargetPx: 36,
          },
        },
        ...form.fields.slice(1),
      ],
    });

    expect(validateContributorRoleApplicationFormQualityGates(broken)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'fields[0].label' }),
      expect.objectContaining({ path: 'fields[0].accessibility.describedBy' }),
      expect.objectContaining({ path: 'fields[0].mobile.minTouchTargetPx' }),
    ]));
  });

  it('regresses when the viewport, submit placement, or error summary stops working on mobile', () => {
    const broken = withFormOverride({
      minViewportWidthPx: 390,
      viewport: {
        width: 'device-width',
        initialScale: 1,
        userScalable: false,
      },
      errorSummary: {
        ...contributorRoleApplicationFormContract().errorSummary,
        focusOnValidationFailure: false,
      },
      submit: {
        ...contributorRoleApplicationFormContract().submit,
        placement: 'before-fields',
        respectsSafeAreaInset: false,
      },
    });

    expect(validateContributorRoleApplicationFormQualityGates(broken)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'minViewportWidthPx' }),
      expect.objectContaining({ path: 'viewport' }),
      expect.objectContaining({ path: 'errorSummary' }),
      expect.objectContaining({ path: 'submit.placement' }),
      expect.objectContaining({ path: 'submit.respectsSafeAreaInset' }),
    ]));
  });

  it('normalizes a bounded application without accepting client-supplied authority fields', () => {
    const result = validateContributorRoleApplicationDraft({
      roleId: 'research-contributor',
      motivation: validMotivation,
      experience: validExperience,
      evidenceUrls: ['https://example.org/research-note'],
      consentToReview: true,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        roleId: 'research-contributor',
        lane: 'research',
        motivation: validMotivation,
        experience: validExperience,
        evidenceUrls: ['https://example.org/research-note'],
        consentToReview: true,
      },
    });
  });

  it('rejects invalid roles, unsafe links, missing consent, and server-derived authority claims', () => {
    const result = validateContributorRoleApplicationDraft({
      roleId: 'admin',
      motivation: 'too short',
      experience: 'also short',
      evidenceUrls: ['javascript:alert(1)'],
      consentToReview: false,
      applicantId: 'client-supplied',
      lane: 'governance',
      reviewer: 'attacker',
    });

    expect(result).toEqual({
      ok: false,
      errors: expect.arrayContaining([
        { field: 'form', message: 'Do not submit server-derived authority field "applicantId".' },
        { field: 'form', message: 'Do not submit server-derived authority field "lane".' },
        { field: 'form', message: 'Do not submit server-derived authority field "reviewer".' },
        { field: 'roleId', message: 'Choose a contributor role.' },
        { field: 'motivation', message: 'Describe why this role is a fit.' },
        { field: 'experience', message: 'Describe relevant experience.' },
        { field: 'evidenceUrls', message: 'Add at least one HTTP or HTTPS evidence link.' },
        { field: 'consentToReview', message: 'Confirm that the application can be reviewed.' },
      ]),
    });
  });

  it('builds a focusable error summary and field-level aria state for invalid mobile submissions', () => {
    const result = validateContributorRoleApplicationDraft({
      roleId: 'governance-contributor',
      motivation: '',
      experience: validExperience,
      evidenceUrls: ['https://example.org/governance-work'],
      consentToReview: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const state = buildContributorRoleApplicationErrorState(result.errors);

    expect(state.summary).toMatchObject({
      role: 'alert',
      tabIndex: -1,
      focusTargetId: 'role-application-errors',
    });
    expect(state.summary.links).toEqual([
      {
        field: 'motivation',
        href: '#role-application-motivation',
        message: 'Describe why this role is a fit.',
      },
    ]);
    expect(state.fields.motivation).toMatchObject({
      ariaInvalid: true,
      ariaDescribedBy: 'role-application-motivation-description role-application-motivation-error',
      errorId: 'role-application-motivation-error',
      errorMessage: 'Describe why this role is a fit.',
    });
    expect(state.fields.experience.ariaInvalid).toBe(false);
  });
});
