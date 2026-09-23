// Kubo Placement acquisition application service.
// UI supplies intent and presentation callbacks; Kubo is the actuator;
// ObjectLifecycle remains the only authority for Placement state.

export const KUBO_PLACEMENT_STATE = Object.freeze({
  ABSENT: "ABSENT",
  PIN_REQUESTED: "PIN_REQUESTED",
  PINNING: "PINNING",
  PRESENT: "PRESENT",
  RETRYABLE: "RETRYABLE",
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createKuboPlacementApplication({
  lifecycleRequest,
  checkPinned,
  requestPin,
  pollIntervalMs = 3_000,
  confirmationTimeoutMs = 180_000,
  sleep = wait,
}) {
  if (typeof lifecycleRequest !== "function") throw new Error("lifecycleRequest is required");
  if (typeof checkPinned !== "function") throw new Error("checkPinned is required");
  if (typeof requestPin !== "function") throw new Error("requestPin is required");

  async function acquire({ objectRef, cid, onState = () => {}, performAcquire = requestPin, existingOnly = false }) {
    if (!objectRef || !cid) throw new Error("ObjectRef and CID are required for Kubo acquisition");

    onState(KUBO_PLACEMENT_STATE.PIN_REQUESTED);
    const requested = await lifecycleRequest({
      action: "requestPlacementAcquire",
      objectRef,
      placement: { kind: "kubo", executor: "browser", locator: { cid } },
    });
    let placement = requested?.lifecycle?.placements?.kubo;
    if (!placement) throw new Error("Lifecycle authority did not return a Kubo Placement");
    if (placement.state === KUBO_PLACEMENT_STATE.PRESENT) {
      onState(KUBO_PLACEMENT_STATE.PRESENT);
      return { state: KUBO_PLACEMENT_STATE.PRESENT, resumed: false };
    }

    let claim = null;
    let resumed = false;
    if (placement.state === KUBO_PLACEMENT_STATE.PINNING && placement.claim) {
      // A reload or a second click joins the authoritative in-flight claim.
      // Duplicate equal reports are idempotent; stale generations are rejected by the DO.
      claim = placement.claim;
      resumed = true;
    } else if (placement.state === KUBO_PLACEMENT_STATE.PIN_REQUESTED) {
      const claimed = await lifecycleRequest({
        action: "claimPlacement",
        objectRef,
        placement: "kubo",
        operation: "acquire",
      });
      claim = claimed?.claim;
      placement = claimed?.lifecycle?.placements?.kubo;
    }
    if (!claim || placement?.state !== KUBO_PLACEMENT_STATE.PINNING) {
      throw new Error(`Kubo Placement is not claimable (${placement?.state || "UNKNOWN"})`);
    }

    onState(KUBO_PLACEMENT_STATE.PINNING);
    try {
      let confirmed = await checkPinned(cid, 1_500);
      if (!confirmed) {
        if (existingOnly) throw new Error("Kubo CID is not pinned");
        const started = await performAcquire(cid);
        if (!started?.success) throw new Error(started?.error || "Kubo pin request failed");
        if (started.cid && started.cid.toLowerCase() !== cid.toLowerCase()) {
          throw new Error("Kubo returned a different content CID");
        }
      }

      const deadline = Date.now() + confirmationTimeoutMs;
      while (!confirmed && Date.now() < deadline) {
        await sleep(pollIntervalMs);
        confirmed = await checkPinned(cid, Math.min(pollIntervalMs, 3_000));
      }
      if (!confirmed) throw new Error("Kubo pin confirmation timed out");

      await lifecycleRequest({
        action: "reportPlacement",
        objectRef,
        placement: "kubo",
        claimId: claim.claimId,
        generation: claim.generation,
        operation: "acquire",
        outcome: "present",
      });
      onState(KUBO_PLACEMENT_STATE.PRESENT);
      return { state: KUBO_PLACEMENT_STATE.PRESENT, resumed };
    } catch (error) {
      await lifecycleRequest({
        action: "reportPlacement",
        objectRef,
        placement: "kubo",
        claimId: claim.claimId,
        generation: claim.generation,
        operation: "acquire",
        outcome: "retryable",
        error: error.message,
      }).catch(() => {});
      onState(KUBO_PLACEMENT_STATE.RETRYABLE, error);
      throw error;
    }
  }

  return { acquire };
}
