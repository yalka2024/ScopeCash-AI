/**
 * Workflow: OutcomeTracking
 * Six-stage monetary outcome recording with funnel visualization.
 *
 * Generated for ScopeCash AI. The workflow runtime (lib/workflow-runtime.js)
 * executes `steps` in order, resolving each step against the agent/tool
 * registries. `agent` optionally pins a default agent for unbound steps.
 */
module.exports = {
  name: "OutcomeTracking",
  description: "Six-stage monetary outcome recording with funnel visualization.",
  steps: ["Record customer-validated amount with evidence upload", "Record submitted amount and submission date", "Record approved or partially approved amount with approval evidence", "Record invoice number, invoice date, and invoiced amount", "Record payment date and collected amount with payment evidence", "Display conversion funnel showing all six stages; preserve full change history"],
  agent: null,
};

