import { buildListWorkbook } from './src/utils/exporter.js';
const wb = await buildListWorkbook({
  title: 'Assets',
  companyName: 'Six Continental Group',
  columns: [
    { header: 'Serial', key: 'serial', width: 18 },
    { header: 'Name', key: 'name', width: 24 },
    { header: 'Status', key: 'status', width: 14 },
  ],
  rows: [
    { serial: 'SCG-001', name: 'Executive Chair', status: 'ASSIGNED' },
    { serial: 'SCG-002', name: 'Dell Laptop', status: 'IN_STOCK' },
  ],
});
await wb.xlsx.writeFile('/tmp/test-assets.xlsx');
import fs from 'fs';
const sz = fs.statSync('/tmp/test-assets.xlsx').size;
console.log('Excel export OK, bytes:', sz);
fs.unlinkSync('/tmp/test-assets.xlsx');
