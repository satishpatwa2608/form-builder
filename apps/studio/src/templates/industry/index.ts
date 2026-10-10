import { CARE_EDUCATION } from './care-education';
import { INSURANCE } from './insurance';
import type { IndustryTemplate } from './kit';
import { SERVICES } from './services';

/** Long, real-world forms by industry: starting points that show what the builder can do. */
export const INDUSTRY_TEMPLATES: IndustryTemplate[] = [...INSURANCE, ...CARE_EDUCATION, ...SERVICES];
export type { IndustryTemplate };
