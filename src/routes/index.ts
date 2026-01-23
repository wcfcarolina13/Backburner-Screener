/**
 * Routes Index
 * Exports all route modules
 */

export { createSettingsRouter } from './settings.js';
// createFocusModeRouter REMOVED - legacy trade copying feature removed
export { createExecutionRouter, getExecutionBridge, initializeBridge } from './execution.js';
