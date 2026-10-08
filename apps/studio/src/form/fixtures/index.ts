import type { FormDefinition } from '../types';
import { parseFormDefinition } from '../engine';
import customerComplaint from './customer-complaint.json';
import customerComplaintBasic from './customer-complaint-basic.json';
import plantIssueReport from './plant-issue-report.json';
import supplierRegistration from './supplier-registration.json';

/** Seed definitions for the local registry. Parsed so a broken fixture fails at load. */
export const fixtureDefinitions: FormDefinition[] = [customerComplaintBasic, customerComplaint, plantIssueReport, supplierRegistration].map((json) =>
  parseFormDefinition(json),
);
