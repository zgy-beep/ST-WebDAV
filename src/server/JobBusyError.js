/**
 * 并发任务冲突错误（备份 / 还原互斥）
 * ------------------------------------------------------------------
 * 同一用户的备份与还原共用同一把 per-handle 互斥锁。任务冲突属于
 * 「客户端稍后重试即可解决」的冲突，而不是服务端内部故障：
 *   - 用专门的错误类型携带 HTTP 409 语义，让路由层能与真正的 500 区分开；
 *   - 避免把「任务占用」误报成服务端错误，前端可以据此区分提示与重试策略。
 */

/** 任务互斥冲突对应的 HTTP 状态码 */
export const HTTP_CONFLICT = 409;

export class JobBusyError extends Error {
  /**
   * @param {string} message 面向用户的中文提示
   */
  constructor(message) {
    super(message);
    this.name = 'JobBusyError';
    this.status = HTTP_CONFLICT;
  }
}

/**
 * 判断错误是否为并发任务冲突
 * @param {unknown} err
 * @returns {boolean}
 */
export function isJobBusyError(err) {
  return err instanceof JobBusyError;
}
