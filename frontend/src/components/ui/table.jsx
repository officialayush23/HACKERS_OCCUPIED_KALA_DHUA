import * as React from 'react'
import { cn } from '@/lib/utils'

const Table = ({ className, ...props }) => (
  <div data-slot="table-container" className="relative w-full overflow-x-auto">
    <table data-slot="table" className={cn('w-full caption-bottom text-sm', className)} {...props} />
  </div>
)
const TableHeader = ({ className, ...props }) => (
  <thead data-slot="table-header" className={cn('[&_tr]:border-b', className)} {...props} />
)
const TableBody = ({ className, ...props }) => (
  <tbody data-slot="table-body" className={cn('[&_tr:last-child]:border-0', className)} {...props} />
)
const TableRow = ({ className, ...props }) => (
  <tr data-slot="table-row"
    className={cn('hover:bg-muted/50 data-[state=selected]:bg-muted border-b transition-colors', className)} {...props} />
)
const TableHead = ({ className, ...props }) => (
  <th data-slot="table-head"
    className={cn('text-muted-foreground h-9 px-2 text-left align-middle font-medium whitespace-nowrap [&:has([role=checkbox])]:pr-0', className)} {...props} />
)
const TableCell = ({ className, ...props }) => (
  <td data-slot="table-cell" className={cn('p-2 align-middle whitespace-nowrap', className)} {...props} />
)
export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell }
