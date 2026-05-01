import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computePriorityScore } from '../src/lib/review.js';

describe('review priority score', () => {
  it('computes the maximum weighted score', () => {
    assert.equal(
      computePriorityScore({
        agentFriendly: 5,
        tokenEfficient: 5,
        userFyi: 5,
      }),
      80,
    );
  });

  it('handles the zero boundary', () => {
    assert.equal(
      computePriorityScore({
        agentFriendly: 0,
        tokenEfficient: 0,
        userFyi: 0,
      }),
      0,
    );
  });

  it('throws for out-of-range or non-integer weights', () => {
    assert.throws(() =>
      computePriorityScore({
        agentFriendly: 6,
        tokenEfficient: 0,
        userFyi: 0,
      }),
    );
    assert.throws(() =>
      computePriorityScore({
        agentFriendly: 0,
        tokenEfficient: 1.5,
        userFyi: 0,
      }),
    );
  });

  it('is monotonic for agentFriendly increases', () => {
    const lower = computePriorityScore({
      agentFriendly: 2,
      tokenEfficient: 2,
      userFyi: 2,
    });
    const higher = computePriorityScore({
      agentFriendly: 3,
      tokenEfficient: 2,
      userFyi: 2,
    });

    assert.equal(higher > lower, true);
  });
});
