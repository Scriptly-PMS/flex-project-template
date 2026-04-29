import * as Flex from '@twilio/flex-ui';
import { Unsubscribe } from '@reduxjs/toolkit';

import AppState from '../../../types/manager/AppState';
import { reduxNamespace } from '../../../utils/state';
import { ExtendedWrapupState } from '../flex-hooks/states/extendedWrapupSlice';
import { TaskQualificationConfig } from '../types/ServiceConfiguration';
import TaskRouterService from '../../../utils/serverless/TaskRouter/TaskRouterService';
import logger from '../../../utils/logger';
// SD-3713: cross-feature imports so the auto-wrapup persistence mirrors the dispositions
// `beforeCompleteTask` hook's three-field write (outcome + content + custom_attributes).
import { isNotesEnabled } from '../../dispositions/config';
import { DispositionsTaskState } from '../../dispositions/flex-hooks/states';

// SD-3713: `manager` is threaded through so the auto-wrapup callback can read the
// dispositions Redux slice and persist the agent's selection before CompleteTask fires.
const startTimer = (
  manager: Flex.Manager,
  task: Flex.ITask,
  taskConfig: TaskQualificationConfig,
  isExtended: boolean,
  unsubscribe?: Unsubscribe,
) => {
  const { sid } = task;
  const scheduledTime =
    task.dateUpdated.getTime() + taskConfig.wrapup_time + (isExtended ? taskConfig.extended_wrapup_time : 0);
  const currentTime = new Date().getTime();
  const timeout = scheduledTime - currentTime > 0 ? scheduledTime - currentTime : 0;

  return window.setTimeout(async () => {
    // Always unsubscribe from redux updates if subscribed so that we don't leak subscriptions
    if (unsubscribe) {
      unsubscribe();
    }
    if (task && Flex.TaskHelper.isInWrapupMode(task)) {
      // SD-3713: persist the agent's disposition input (held in the dispositions Redux slice)
      // before CompleteTask. Mirrors the three-field write from the upstream
      // `beforeCompleteTask` hook (dispositions/flex-hooks/actions/CompleteTask.ts) so the
      // auto-wrapup path doesn't drop notes / custom_attributes when the hook bypasses or
      // aborts persistence. The hook can't be relied on here: under `require_disposition` it
      // aborts CompleteTask, and under native (Agent Copilot) wrapup it bypasses the abort
      // *without* persisting any data. Falls back to `taskConfig.default_outcome` only for
      // the `outcome` field, when no agent selection exists. Optional chaining keeps this
      // safe when the dispositions feature flag is off (slice never registered).
      const taskDisposition: DispositionsTaskState | undefined = (manager.store.getState() as AppState)[reduxNamespace]
        .dispositions?.tasks?.[task.taskSid];
      const outcomeToSave = taskDisposition?.disposition || taskConfig.default_outcome;

      const conversations: Record<string, string> = {};
      if (outcomeToSave) {
        conversations.outcome = outcomeToSave;
      }
      if (isNotesEnabled() && taskDisposition?.notes) {
        conversations.content = taskDisposition.notes;
      }
      if (taskDisposition?.custom_attributes) {
        Object.assign(conversations, taskDisposition.custom_attributes);
      }

      if (Object.keys(conversations).length > 0) {
        try {
          await TaskRouterService.updateTaskAttributes(task.taskSid, { conversations }, true);
        } catch (error) {
          logger.error(`[agent-automation] Error updating task attributes: ${error}`);
        }
      }
      logger.info(`[agent-automation] Performing auto-wrapup for ${sid}`);
      Flex.Actions.invokeAction('CompleteTask', { sid });
      return;
    }
    logger.info(`[agent-automation] Didn't auto-wrapup due to task already completed for ${sid}`);
  }, timeout);
};

export const setAutoCompleteTimeout = async (
  manager: Flex.Manager,
  task: Flex.ITask,
  taskConfig: TaskQualificationConfig,
) => {
  const state = manager.store.getState() as AppState;
  const { extendedReservationSids } = state[reduxNamespace].extendedWrapup as ExtendedWrapupState;
  const { sid } = task;
  let isExtended = extendedReservationSids.includes(sid);

  if (!taskConfig) {
    return;
  }

  if (isExtended && taskConfig.extended_wrapup_time < 1) {
    return;
  }

  try {
    logger.info(`[agent-automation] Setting auto-wrapup timer for ${sid}`);
    let wrapTimer: number;

    // Subscribe to redux updates if we need to handle extended wrapup
    const unsubscribe = taskConfig.allow_extended_wrapup
      ? manager.store.subscribe(() => {
          const newState = manager.store.getState() as AppState;
          const { extendedReservationSids: newExtendedReservationSids } = newState[reduxNamespace]
            .extendedWrapup as ExtendedWrapupState;
          const newIsExtended = newExtendedReservationSids.includes(sid);

          // This callback function runs for every redux update; we only care about when this task's extended wrapup state changes
          if (isExtended === newIsExtended) {
            return;
          }
          isExtended = newIsExtended;

          if (wrapTimer) {
            logger.info(`[agent-automation] Clearing existing auto-wrapup timer for ${sid}`);
            window.clearTimeout(wrapTimer);
          }
          if (
            taskConfig &&
            taskConfig.auto_wrapup &&
            taskConfig.allow_extended_wrapup &&
            (!isExtended || taskConfig.extended_wrapup_time > 0)
          ) {
            logger.info(`[agent-automation] Creating new auto-wrapup timer for ${sid}`);
            wrapTimer = startTimer(manager, task, taskConfig, isExtended, unsubscribe);
          }
        })
      : undefined;

    wrapTimer = startTimer(manager, task, taskConfig, isExtended, unsubscribe);
  } catch (error: any) {
    logger.error(`Error attempting to set wrap up timeout for reservation: ${sid}`, error);
  }
};
