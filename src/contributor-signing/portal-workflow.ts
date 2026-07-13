// SPDX-License-Identifier: MIT

import type {
  AuthenticatedCaller,
  ContributorDecisionRecord,
  ContributorDecisionRequest,
} from './types.js';
import type { ContributorSigningPolicyService } from './policy-service.js';

/**
 * Portal-specific identity verification boundary.
 *
 * Implementations may recover a wallet address, validate an agent session, or
 * verify another non-custodial proof. They must return only server-trusted
 * caller data; the workflow never accepts client-supplied identity claims as
 * authority.
 */
export interface PortalIdentityVerifier<IdentityProof = unknown> {
  verify(
    proof: IdentityProof,
    request: Readonly<ContributorDecisionRequest>,
  ): AuthenticatedCaller | null | Promise<AuthenticatedCaller | null>;
}

export interface PortalActionInput<IdentityProof = unknown> {
  identity?: IdentityProof | null;
  request: ContributorDecisionRequest;
}

export type PortalActionOutcome<Result> =
  | {
      status: 'denied';
      reason: string;
      decision?: ContributorDecisionRecord;
    }
  | {
      status: 'executed';
      decision: ContributorDecisionRecord;
      result: Result;
    };

export type PortalBoundedActionExecutor<Result> = (
  request: Readonly<ContributorDecisionRequest>,
  decision: Readonly<ContributorDecisionRecord>,
) => Result | Promise<Result>;

/**
 * Fail-closed portal gate: identity verification precedes authorization, and
 * the configured effect is unreachable unless the policy returns `approved`.
 * The executor is constructor-injected so a request cannot select an arbitrary
 * effect after it has passed policy checks.
 */
export class ContributorPortalWorkflow<IdentityProof = unknown, Result = unknown> {
  constructor(
    private readonly identities: PortalIdentityVerifier<IdentityProof>,
    private readonly policy: ContributorSigningPolicyService,
    private readonly executeBoundedAction: PortalBoundedActionExecutor<Result>,
  ) {}

  async run(input: PortalActionInput<IdentityProof>): Promise<PortalActionOutcome<Result>> {
    if (input.identity === null || input.identity === undefined) {
      return { status: 'denied', reason: 'identity proof is required' };
    }
    const request = Object.freeze({ ...input.request });

    let caller: AuthenticatedCaller | null;
    try {
      caller = await this.identities.verify(input.identity, request);
    } catch {
      return { status: 'denied', reason: 'identity proof verification failed' };
    }
    if (!caller) {
      return { status: 'denied', reason: 'identity proof verification failed' };
    }

    let decision: ContributorDecisionRecord;
    try {
      decision = this.policy.decide(request, caller);
    } catch {
      return { status: 'denied', reason: 'authorization policy evaluation failed' };
    }
    if (decision.decision !== 'approved') {
      return { status: 'denied', reason: decision.reason, decision };
    }

    let result: Result;
    try {
      result = await this.executeBoundedAction(request, decision);
    } catch {
      return { status: 'denied', reason: 'bounded action execution failed', decision };
    }
    return { status: 'executed', decision, result };
  }
}
