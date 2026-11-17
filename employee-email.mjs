export function isEmployeeEmail(email) {
  return typeof email === 'string' && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@sparkinfosol\.com$/i.test(email.trim());
}
