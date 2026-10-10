import { CARE_EDUCATION } from './care-education';
import { ENERGY_BANKING } from './energy-banking';
import { GOVERNMENT } from './government';
import { INSURANCE } from './insurance';
import type { IndustryTemplate } from './kit';
import { PEOPLE_COMMERCE } from './people-commerce';
import { SERVICES } from './services';
import { withAfterSending, withSharedWorkflow } from './showcase';

/** Long, real-world forms by industry: starting points that show what the builder can do. */
export const INDUSTRY_TEMPLATES: IndustryTemplate[] = [...INSURANCE, ...CARE_EDUCATION, ...SERVICES, ...GOVERNMENT, ...ENERGY_BANKING, ...PEOPLE_COMMERCE].map(withAfterSending).map(withSharedWorkflow);
export type { IndustryTemplate };
