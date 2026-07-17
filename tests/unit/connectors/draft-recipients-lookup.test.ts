// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { NullDraftRecipientsLookup } from '../../../src/connectors/runtime/draft-recipients-lookup.js';

describe('NullDraftRecipientsLookup', () => {
  it('always reports the draft as unavailable, regardless of the query', async () => {
    const lookup = new NullDraftRecipientsLookup();
    const result = await lookup.getRecipients({
      connectorId: 'gmail',
      connectionId: 'conn-1',
      agentId: 'agent-a',
      tenantId: 'tenant-a',
      draftId: 'd1',
    });
    expect(result).toBeNull();
  });
});
