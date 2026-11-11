import { ACCEPTANCE_REVIEW_SYSTEM_PROMPT } from './missionAcceptanceReview.js';

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Static markup for the optional bootstrap acceptance review. */
export const missionAcceptanceReviewHtml = `
<section id="missionAcceptanceReview" aria-labelledby="acceptanceReviewHeading" hidden>
  <h4 id="acceptanceReviewHeading">Optional independent acceptance review</h4>
  <p class="hint">Spark reviews only the requirements and selected test fragments. It receives no tools, cannot change files or criteria, and cannot approve or complete the Mission.</p>
  <dl id="acceptanceReviewContext" class="mission-facts"></dl>
  <p id="acceptanceReviewAvailability" class="hint" role="status" aria-live="polite"></p>
  <div id="acceptanceReviewBudgets">
    <label for="acceptanceReviewConsultations">Maximum review consultations</label>
    <select id="acceptanceReviewConsultations" aria-label="Maximum review consultations">
      <option value="1" selected>1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5">5</option><option value="10">10</option><option value="100">100</option><option value="1000">1000</option><option value="-1">No count limit</option>
    </select>
    <label for="acceptanceReviewRequestBytes">Request bytes at most (empty = 12000)</label>
    <input id="acceptanceReviewRequestBytes" type="number" min="1000" max="24000" step="1" placeholder="12000">
    <label for="acceptanceReviewOutputTokens">Output tokens at most (empty = 2048)</label>
    <input id="acceptanceReviewOutputTokens" type="number" min="256" max="8192" step="1" placeholder="2048">
    <label for="acceptanceReviewTotalTokens">Total remote token bound (empty = 14048)</label>
    <input id="acceptanceReviewTotalTokens" type="number" min="1000" max="14048000" step="1" placeholder="14048 × consultations">
  </div>
  <div class="row"><button id="acceptanceReviewPrepare" type="button">Prepare Spark review</button></div>
  <div id="acceptanceReviewOffer" hidden>
    <p id="acceptanceReviewSummary" class="mission-note"></p>
    <pre id="acceptanceReviewPayload"></pre>
    <details id="acceptanceReviewSystemDetails">
      <summary>Fixed instructions sent with it, the same for every review</summary>
      <pre id="acceptanceReviewSystem">${escapeHtml(ACCEPTANCE_REVIEW_SYSTEM_PROMPT)}</pre>
    </details>
    <div class="row">
      <button id="acceptanceReviewSend" type="button">Send this exact review</button>
      <button id="acceptanceReviewCancel" type="button">Cancel review</button>
    </div>
  </div>
  <div id="acceptanceReviewResult" hidden>
    <p id="acceptanceReviewRecommendation"></p>
    <div id="acceptanceReviewFindings"></div>
    <p class="hint">Untrusted advisory data: review it, then choose the final acceptance command and files below. No suggestion is applied automatically.</p>
    <div class="row">
      <button id="acceptanceReviewConsider" type="button">I considered this review</button>
      <button id="acceptanceReviewDismiss" type="button">Reject these suggestions</button>
    </div>
  </div>
</section>`;
