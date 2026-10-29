/**
 * `print_jobs` / `print_cancel`：打印队列的只读查看与取消。
 *
 * @module @local/print/tools/jobs
 */

import { printError } from '../errors.js';
import { defineTool } from '../tool-kit.js';
import { TEXT_OUTPUT, planUnlessConfirmed, runTool, text } from './shared.js';

/**
 * 渲染一个任务行。
 * @param {{ id: number, document: string, status: string, pages: number, totalPages: number, position: number }} job - 任务。
 * @returns {string} 文本。
 */
function describeJob(job) {
  const pages = Number.isFinite(job.totalPages) && job.totalPages > 0
    ? `${job.pages ?? 0}/${job.totalPages} 页`
    : `${job.pages ?? 0} 页`;
  const position = job.position > 0 ? `，队列位 #${job.position}` : '';
  return `#${job.id} ${job.document || '（无文档名）'} —— ${job.status || '未知状态'}，${pages}${position}`;
}

/**
 * 注册队列工具。
 * @param {object} deps - 依赖。
 * @returns {object[]} 工具定义。
 */
export function createJobTools(deps) {
  return [
    defineTool({
      name: 'print_jobs',
      description: '查看本机打印队列里的任务（任务号、文档名、状态、已打印/总页数、队列位置）。可指定打印机；只读，不改变队列。',
      parameters: {
        printer: { type: 'string', description: '打印机名称；不传则看所有打印机的任务。' },
        limit: { type: 'integer', description: '最多返回多少条，默认 20。', default: 20 },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(rawArgs) {
        const args = rawArgs ?? {};
        return runTool(deps, 'print_jobs', args, async () => {
          const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(100, args.limit)) : 20;
          const data = await deps.helper.invoke(
            'jobs',
            { printer: typeof args.printer === 'string' ? args.printer : '' },
            { timeoutMs: deps.config.requestTimeoutMs },
          );
          const jobs = Array.isArray(data.jobs) ? data.jobs : [];
          const lines = [`打印队列${data.printer ? `（${data.printer}）` : ''}：${jobs.length} 个任务`];
          for (const job of jobs.slice(0, limit)) lines.push(`  ${describeJob(job)}`);
          if (jobs.length === 0) lines.push('  队列是空的。');
          return text(lines.join('\n'));
        });
      },
    }),
    defineTool({
      name: 'print_cancel',
      description: '取消打印队列里的任务（按 jobId，或 all=true 取消该打印机的全部任务）。默认先返回计划，确认后带 confirm=true 才真正取消。',
      parameters: {
        printer: { type: 'string', required: true, description: '打印机名称。' },
        jobId: { type: 'integer', description: '要取消的任务号（print_jobs 里的 id）。' },
        all: { type: 'boolean', description: '取消该打印机的全部任务；和 jobId 二选一。', default: false },
        confirm: { type: 'boolean', description: '确认执行；默认 false 只返回计划。', default: false },
      },
      output: TEXT_OUTPUT,
      async execute(rawArgs) {
        const args = rawArgs ?? {};
        return runTool(deps, 'print_cancel', args, async () => {
          const printer = String(args.printer ?? '').trim();
          if (printer === '') throw printError('E_BAD_ARGS', '取消任务必须指定 printer。');
          const all = args.all === true;
          const jobId = Number.isFinite(args.jobId) ? args.jobId : undefined;
          if (!all && jobId === undefined) throw printError('E_BAD_ARGS', '需要 jobId，或 all=true 取消全部任务。');

          const current = await deps.helper.invoke('jobs', { printer }, { timeoutMs: deps.config.requestTimeoutMs });
          const jobs = Array.isArray(current.jobs) ? current.jobs : [];
          const targets = all ? jobs : jobs.filter((job) => job.id === jobId);
          const planLines = [`取消打印任务计划（尚未执行）`, `打印机：${printer}`];
          if (targets.length === 0) {
            planLines.push(all ? '该打印机当前没有任务。' : `找不到任务 #${jobId}（当前 ${jobs.length} 个任务）。`);
          } else {
            planLines.push(`将取消 ${targets.length} 个任务：`);
            for (const job of targets) planLines.push(`  ${describeJob(job)}`);
          }
          const plan = planLines.join('\n');
          const planned = planUnlessConfirmed(deps, 'print_cancel', args, plan);
          if (planned) return planned;
          if (targets.length === 0) return text(`${plan}\n\n没有可取消的任务，未做任何改动。`);

          const result = await deps.helper.invoke(
            'cancel',
            all ? { printer, all: true } : { printer, jobId },
            { timeoutMs: deps.config.requestTimeoutMs },
          );
          return text(`已取消 ${result.removed ?? targets.length} 个打印任务（${printer}）。`);
        });
      },
    }),
  ];
}
