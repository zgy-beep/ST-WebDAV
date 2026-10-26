/**
 * 按用户句柄 (handle) 的任务互斥锁
 * ------------------------------------------------------------------
 * 背景：备份与还原原先各自维护独立的 active 集合，导致同一用户可以同时
 *      发起备份与还原 —— 还原覆写 settings.json 的同时备份正在归档它，
 *      会产出前后不一致的"成功"备份包。本锁把两类任务收敛为同一把
 *      per-handle 互斥锁。
 */

import { JobBusyError } from './JobBusyError.js';

/**
 * @typedef {'backup' | 'restore'} JobType
 */

export class JobLock {
  /** @type {Map<string, { type: JobType, startedAt: number }>} */
  static locks = new Map();

  /**
   * 获取指定用户的任务锁
   * @param {string} handle 用户句柄
   * @param {JobType} type 任务类型
   * @returns {() => void} 释放函数
   */
  static acquire(handle, type) {
    const key = String(handle || 'default-user');
    const existing = JobLock.locks.get(key);

    if (existing) {
      if (existing.type !== type) {
        throw new JobBusyError('该用户有正在进行的备份/还原任务，请等待其完成后重试');
      }
      throw new JobBusyError(type === 'backup'
        ? '另一个备份任务正在进行中，请勿重复触发'
        : '另一个恢复任务正在进行中，请稍候');
    }

    JobLock.locks.set(key, { type, startedAt: Date.now() });
    return () => JobLock.release(key);
  }

  /**
   * 释放指定用户的任务锁
   * @param {string} handle
   */
  static release(handle) {
    JobLock.locks.delete(String(handle || 'default-user'));
  }

  /**
   * 查询指定用户当前是否有在途任务
   * @param {string} handle
   * @returns {{ type: JobType, startedAt: number } | null}
   */
  static peek(handle) {
    return JobLock.locks.get(String(handle || 'default-user')) || null;
  }

  /**
   * 当前是否有任意在途任务（供插件卸载时等待用）
   * @returns {boolean}
   */
  static get hasActiveJobs() {
    return JobLock.locks.size > 0;
  }
}
