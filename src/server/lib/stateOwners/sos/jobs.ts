import { randomUUID } from 'node:crypto';
import type { BusinessOwnerJobSnapshot, BusinessOwnerJobStatus } from './types.js';

const jobs = new Map<string, BusinessOwnerJobSnapshot>();

export function newJobId(): string {
  return `biz-owner-${randomUUID().slice(0, 8)}`;
}

export function putJob(row: BusinessOwnerJobSnapshot): BusinessOwnerJobSnapshot {
  jobs.set(row.job_id, row);
  return row;
}

export function getJob(jobId: string): BusinessOwnerJobSnapshot | null {
  return jobs.get(jobId) ?? null;
}

export function patchJob(jobId: string, patch: Partial<BusinessOwnerJobSnapshot>): BusinessOwnerJobSnapshot | null {
  const cur = jobs.get(jobId);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  jobs.set(jobId, next);
  return next;
}

export function resetJobsForTests(): void {
  jobs.clear();
}

export function completeJob(jobId: string, status: BusinessOwnerJobStatus = 'completed'): BusinessOwnerJobSnapshot | null {
  return patchJob(jobId, { status });
}
