import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { LscCanDirective } from '@core/auth/can.directive';
import { errorText } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { FeatureStateComponent } from '@shared/components/feedback/feature-state.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import { ExecutionApiService } from '../execution-api.service';
import { emptyGroup, groupProblems, statusTone } from '../execution.logic';
import type {
  AllocationGroup,
  AllocationMethod,
  AllocationPreview,
  BlockOrder,
  SaveAllocationGroup,
} from '../execution.types';

/** The preview form's hypothetical signal. */
interface PreviewInputs {
  symbol: string;
  direction: 'Buy' | 'Sell';
  lots: number;
  entryPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  mlConfidence: number | null;
}

/**
 * Allocation groups (gaps program, execution; MAM-style): a set of accounts that trade a strategy's signals as one
 * block, each account's share sized by pro-rata equity, equal risk, fixed ratio or Kelly. Create / edit / retire,
 * a hypothetical allocation preview before saving, and the block orders with their average-price allocation report.
 */
@Component({
  selector: 'app-allocation-groups-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DatePipe, DecimalPipe, RouterLink, LscCanDirective, PageHeaderComponent, FeatureStateComponent, ConfirmDialogComponent],
  styleUrls: ['../../iam/shared/iam-page.scss', './execution-page.scss'],
  template: `
    <div class="page">
      <app-page-header
        title="Allocation groups"
        subtitle="Accounts that trade a strategy's signals as one block: each share sized by the group's method, each order through its own risk check."
      />

      @if (groups.value(); as list) {
        @if (list.length && !list[0].allocationEnabled) {
          <app-feature-state
            title="Block allocation is off"
            kind="off"
            stateLabel="Off"
            switchKey="Execution:Allocation:Enabled"
            summary="Groups are kept but trade nothing as a block: every account sizes its own order as before (bindings, lot multipliers). Platform staff switch blocks on in Execution settings."
            [links]="[{ label: 'Execution settings', route: '/execution/settings' }]"
          />
        }
      }
      @if (message()) {
        <p class="ok-line" role="status">{{ message() }}</p>
      }
      @if (error()) {
        <p class="alert" role="alert">{{ error() }}</p>
      }

      <section class="card">
        <div class="card-head">
          <h3>Groups</h3>
          <button type="button" class="btn btn-sm btn-primary" *lscCan="'accounts.manage'" (click)="edit(null)">New group</button>
        </div>
        @if (groups.value(); as list) {
          @if (list.length) {
            <table class="table">
              <thead><tr><th>Name</th><th>Strategy</th><th>Method</th><th>Members</th><th>Blocks</th><th>Active</th><th>Updated</th><th></th></tr></thead>
              <tbody>
                @for (g of list; track g.id) {
                  <tr>
                    <td><strong>{{ g.name }}</strong><div class="muted">{{ g.description }}</div></td>
                    <td>{{ g.strategyName ?? '#' + g.strategyId }}</td>
                    <td>{{ g.method }}</td>
                    <td>{{ g.members.length }}</td>
                    <td><button type="button" class="btn btn-sm btn-ghost" (click)="showBlocks(g.id)">{{ g.blocks }}</button></td>
                    <td>{{ g.isActive ? 'yes' : 'no' }}</td>
                    <td>{{ g.updatedAtUtc | date: 'MMM d HH:mm' : 'UTC' }}{{ g.updatedBy ? ' · ' + g.updatedBy : '' }}</td>
                    <td>
                      <span *lscCan="'accounts.manage'">
                        <button type="button" class="btn btn-sm btn-secondary" (click)="edit(g)">Edit</button>
                        <button type="button" class="btn btn-sm btn-danger" (click)="toDelete.set(g)">Retire</button>
                      </span>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <p class="muted" style="padding: 12px 16px">
              No allocation group yet. A group trades ONE strategy's signals as a block across its member accounts; accounts
              outside any group keep today's per-account sizing.
            </p>
          }
        } @else if (groups.error(); as err) {
          <p class="alert" role="alert">{{ err }}</p>
        }
      </section>

      @if (draft(); as d) {
        <section class="card">
          <div class="card-head"><h3>{{ editingId() ? 'Edit group ' + editingId() : 'New group' }}</h3></div>
          <div class="form">
            <label>Name<input class="input" [ngModel]="d.name" (ngModelChange)="patch({ name: $event })" /></label>
            <label>Strategy id<input class="input" type="number" min="1" [ngModel]="d.strategyId" (ngModelChange)="patch({ strategyId: +$event })" /></label>
            <label>Method
              <select class="input" [ngModel]="d.method" (ngModelChange)="patch({ method: $event })">
                @for (m of methods; track m) { <option [value]="m">{{ m }}</option> }
              </select>
            </label>
            <label>Block = signal lots ×<input class="input" type="number" step="0.01" [ngModel]="d.blockLotMultiplier" (ngModelChange)="patch({ blockLotMultiplier: +$event })" /></label>
            @if (d.method === 'EqualRisk') {
              <label>Risk per account (fraction of equity)<input class="input" type="number" step="0.001" [ngModel]="d.riskFraction" (ngModelChange)="patch({ riskFraction: +$event })" /></label>
            }
            @if (d.method === 'Kelly') {
              <label>Kelly cap (fraction of equity)<input class="input" type="number" step="0.001" [ngModel]="d.maxKellyFraction" (ngModelChange)="patch({ maxKellyFraction: +$event })" /></label>
            }
            <label class="check"><input type="checkbox" [ngModel]="d.averagePriceAllocation" (ngModelChange)="patch({ averagePriceAllocation: $event })" /> record the average-price allocation</label>
            <label class="check"><input type="checkbox" [ngModel]="d.isActive" (ngModelChange)="patch({ isActive: $event })" /> active</label>
            <label style="grid-column: 1 / -1">Description<input class="input" [ngModel]="d.description ?? ''" (ngModelChange)="patch({ description: $event || null })" /></label>
          </div>
          <div class="card-head"><h3>Members</h3><span class="hint">trading account ids; the ratio is used by FixedRatio</span></div>
          <table class="table">
            <thead><tr><th>Account id</th><th>Ratio</th><th>Active</th><th></th></tr></thead>
            <tbody>
              @for (m of d.members; track $index; let i = $index) {
                <tr>
                  <td><input class="input num" type="number" min="1" [ngModel]="m.tradingAccountId" (ngModelChange)="member(i, { tradingAccountId: +$event })" /></td>
                  <td><input class="input num" type="number" step="0.1" [ngModel]="m.ratio" (ngModelChange)="member(i, { ratio: +$event })" /></td>
                  <td><input type="checkbox" [ngModel]="m.isActive" (ngModelChange)="member(i, { isActive: $event })" /></td>
                  <td><button type="button" class="btn btn-sm btn-ghost" (click)="removeMember(i)">Remove</button></td>
                </tr>
              }
            </tbody>
          </table>
          <p style="padding: 0 16px"><button type="button" class="btn btn-sm btn-secondary" (click)="addMember()">Add member</button></p>

          <div class="card-head"><h3>Preview a hypothetical signal</h3><span class="hint">writes nothing</span></div>
          <div class="form">
            <label>Symbol<input class="input" [ngModel]="pv().symbol" (ngModelChange)="pvPatch({ symbol: $event })" /></label>
            <label>Direction
              <select class="input" [ngModel]="pv().direction" (ngModelChange)="pvPatch({ direction: $event })"><option>Buy</option><option>Sell</option></select>
            </label>
            <label>Signal lots<input class="input" type="number" step="0.01" [ngModel]="pv().lots" (ngModelChange)="pvPatch({ lots: +$event })" /></label>
            <label>Entry<input class="input" type="number" step="0.00001" [ngModel]="pv().entryPrice" (ngModelChange)="pvPatch({ entryPrice: +$event })" /></label>
            <label>Stop<input class="input" type="number" step="0.00001" [ngModel]="pv().stopLoss" (ngModelChange)="pvPatch({ stopLoss: $event === '' ? null : +$event })" /></label>
            <label>Target<input class="input" type="number" step="0.00001" [ngModel]="pv().takeProfit" (ngModelChange)="pvPatch({ takeProfit: $event === '' ? null : +$event })" /></label>
            <label>ML confidence (0–1, Kelly)<input class="input" type="number" step="0.01" [ngModel]="pv().mlConfidence" (ngModelChange)="pvPatch({ mlConfidence: $event === '' ? null : +$event })" /></label>
          </div>
          <p style="padding: 0 16px"><button type="button" class="btn btn-sm btn-secondary" [disabled]="busy()" (click)="runPreview()">Preview allocation</button></p>
          @if (preview(); as p) {
            <p class="hint-line">{{ p.methodUsed }} · {{ p.totalLots }} lots{{ p.note ? ' · ' + p.note : '' }}</p>
            <table class="table">
              <thead><tr><th>Account</th><th class="num">Equity</th><th class="num">Share</th><th class="num">Lots</th><th>Note</th></tr></thead>
              <tbody>
                @for (s of p.shares; track s.tradingAccountId) {
                  <tr><td>{{ s.accountName ?? s.tradingAccountId }}</td><td class="num">{{ s.equity | number: '1.0-0' }}</td><td class="num">{{ s.fraction * 100 | number: '1.1-1' }} %</td><td class="num">{{ s.lots | number: '1.2-2' }}</td><td>{{ s.note }}</td></tr>
                }
              </tbody>
            </table>
            <p class="hint-line">Each share is still checked by its account's own risk profile at order time, which may reduce or refuse it.</p>
          }

          @for (p of problems(); track p) {
            <p class="alert">{{ p }}</p>
          }
          <p style="padding: 8px 16px">
            <button type="button" class="btn btn-primary" [disabled]="problems().length > 0 || busy()" (click)="save()">Save group</button>
            <button type="button" class="btn btn-ghost" (click)="draft.set(null)">Close</button>
          </p>
        </section>
      }

      @if (blocks.value(); as bl) {
        <section class="card">
          <div class="card-head"><h3>Block orders{{ blocksGroup() ? ' of group ' + blocksGroup() : '' }}</h3></div>
          @if (bl.length) {
            <table class="table">
              <thead><tr><th>#</th><th>Group</th><th>Signal</th><th>Symbol</th><th>Method</th><th class="num">Lots (filled / total)</th><th class="num">Block avg</th><th>Status</th><th>Created</th></tr></thead>
              <tbody>
                @for (b of bl; track b.id) {
                  <tr>
                    <td><a [routerLink]="['/execution/blocks', b.id]">{{ b.id }}</a></td>
                    <td>{{ b.groupName }}</td>
                    <td>{{ b.tradeSignalId }}</td>
                    <td>{{ b.direction }} {{ b.symbol }}</td>
                    <td>{{ b.method }}</td>
                    <td class="num">{{ b.filledLots | number: '1.2-2' }} / {{ b.totalLots | number: '1.2-2' }}</td>
                    <td class="num">{{ b.averagePrice !== null ? (b.averagePrice | number: '1.5-5') : '—' }}</td>
                    <td [class]="'tone-' + tone(b.status)">{{ b.status }}</td>
                    <td>{{ b.createdAt | date: 'MMM d HH:mm' : 'UTC' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <p class="muted" style="padding: 12px 16px">No block order yet. One is created when a signal of a group's strategy is first claimed by a member while block allocation is on.</p>
          }
        </section>
      }

      <app-confirm-dialog
        [open]="!!toDelete()"
        title="Retire this allocation group?"
        [message]="'Group ' + (toDelete()?.name ?? '') + ' stops trading as a block: its accounts size their own orders again. Its block orders stay as the record.'"
        confirmLabel="Retire"
        [loading]="busy()"
        (confirm)="remove()"
        (cancelled)="toDelete.set(null)"
      />
    </div>
  `,
})
export class AllocationGroupsPageComponent {
  private readonly api = inject(ExecutionApiService);

  protected readonly methods: AllocationMethod[] = ['ProRataEquity', 'EqualRisk', 'FixedRatio', 'Kelly'];
  readonly groups = iamResource<AllocationGroup[] | null>(() => this.api.groups(), null, 'Could not load the allocation groups.');
  readonly blocksGroup = signal<number | null>(null);
  readonly blocks = iamResource<BlockOrder[] | null>(() => this.api.blocks(this.blocksGroup(), 50), null, 'Could not load the block orders.');

  readonly draft = signal<SaveAllocationGroup | null>(null);
  readonly editingId = signal<number | null>(null);
  readonly toDelete = signal<AllocationGroup | null>(null);
  readonly busy = signal(false);
  readonly message = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly preview = signal<AllocationPreview | null>(null);
  readonly pv = signal<PreviewInputs>({ symbol: 'EURUSD', direction: 'Buy', lots: 1, entryPrice: 1.1, stopLoss: 1.095, takeProfit: 1.11, mlConfidence: null });

  readonly problems = computed(() => {
    const d = this.draft();
    return d ? groupProblems(d) : [];
  });

  constructor() {
    this.groups.reload();
    this.blocks.reload();
  }

  tone = statusTone;

  edit(g: AllocationGroup | null): void {
    this.preview.set(null);
    this.editingId.set(g?.id ?? null);
    this.draft.set(
      g
        ? {
            name: g.name, description: g.description, strategyId: g.strategyId, method: g.method,
            blockLotMultiplier: g.blockLotMultiplier, riskFraction: g.riskFraction, maxKellyFraction: g.maxKellyFraction,
            averagePriceAllocation: g.averagePriceAllocation, isActive: g.isActive,
            members: g.members.map((m) => ({ tradingAccountId: m.tradingAccountId, ratio: m.ratio, isActive: m.isActive })),
          }
        : emptyGroup(),
    );
  }

  patch(p: Partial<SaveAllocationGroup>): void {
    this.draft.update((d) => (d ? { ...d, ...p } : d));
  }

  member(i: number, p: Partial<SaveAllocationGroup['members'][number]>): void {
    this.draft.update((d) => (d ? { ...d, members: d.members.map((m, j) => (j === i ? { ...m, ...p } : m)) } : d));
  }

  addMember(): void {
    this.draft.update((d) => (d ? { ...d, members: [...d.members, { tradingAccountId: 0, ratio: 1, isActive: true }] } : d));
  }

  removeMember(i: number): void {
    this.draft.update((d) => (d ? { ...d, members: d.members.filter((_, j) => j !== i) } : d));
  }

  pvPatch(p: Partial<PreviewInputs>): void {
    this.pv.update((v) => ({ ...v, ...p }));
  }

  runPreview(): void {
    const d = this.draft();
    if (!d) return;
    this.busy.set(true);
    this.api.preview(null, { draft: d, ...this.pv() }).subscribe({
      next: (p) => {
        this.busy.set(false);
        this.preview.set(p);
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(errorText(e, 'The preview failed.'));
      },
    });
  }

  save(): void {
    const d = this.draft();
    if (!d || this.problems().length) return;
    this.busy.set(true);
    this.error.set(null);
    const id = this.editingId();
    (id ? this.api.updateGroup(id, d) : this.api.createGroup(d)).subscribe({
      next: (g) => {
        this.busy.set(false);
        this.draft.set(null);
        this.message.set(`Group ${g.name} saved.`);
        this.groups.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(errorText(e, 'The group was not saved.'));
      },
    });
  }

  remove(): void {
    const g = this.toDelete();
    if (!g) return;
    this.busy.set(true);
    this.api.deleteGroup(g.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.toDelete.set(null);
        this.message.set(`Group ${g.name} retired.`);
        this.groups.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.toDelete.set(null);
        this.error.set(errorText(e, 'The group was not retired.'));
      },
    });
  }

  showBlocks(groupId: number): void {
    this.blocksGroup.set(groupId);
    this.blocks.reload();
  }
}
