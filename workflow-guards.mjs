export function workflowError(message) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

export function requireRecruitable(candidate) {
  if (!candidate || ['Inducted', 'Rejected', 'Archived'].includes(candidate.status)) throw workflowError('Choose an active candidate who has not been rejected, archived or inducted.');
}

export function requireInterviewSelection(candidate, interviews) {
  requireRecruitable(candidate);
  if (!interviews.some(interview => interview.decision === 'Selected' && interview.meetingLink && interview.scheduledAt)) throw workflowError('Schedule the interview, send its invitation and record a Selected interview decision before requesting documents or preparing an offer.');
}

export function requireActiveEmployee(employee, today = new Date().toISOString().slice(0, 10)) {
  const start = employee?.inductedAt || employee?.joiningDate;
  if (!employee?.id || !String(employee.employeeCode || '').trim() || employee.status !== 'Active' || !/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !Number.isFinite(Date.parse(start)) || start > today) throw workflowError('An active employee with a permanent employee ID and a completed joining/induction date is required.');
}

export function requireAssessmentOrder(tests, testId) {
  const index = tests.findIndex(test => test.id === testId);
  if (index < 0 || tests.slice(0, index).some(test => test.status !== 'Passed')) throw workflowError('Pass the previous weekly assessment before taking this assessment.');
}

export function nextCode(codes) {
  const maximum = codes.reduce((max, code) => Math.max(max, Number(/^SPARK-(\d+)$/.exec(code || '')?.[1] || 0)), 0);
  return `SPARK-${String(maximum + 1).padStart(4, '0')}`;
}
