import { db } from './src/db/index.js';
import { crawlJobs } from './src/db/schema.js';

const columns = crawlJobs._.columns;
console.log('Columns in crawl_jobs:');
Object.keys(columns).forEach(name => {
  console.log(`  - ${name}`);
});
