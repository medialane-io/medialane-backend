# Page Refactor Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four concrete issues found across Portfolio, Collections, and Creators pages: migrate the `useSessionKey` compatibility shim to `useUnifiedWallet`, fix portfolio stats to include ERC-1155 listings, add a Drops source filter tab to the Collections page, and add load-more pagination to the Creators page.

**Architecture:** All changes are confined to client components. No new hooks, no new files — only edits to existing pages and one shared component. Each task is independently deployable.

**Tech Stack:** Next.js 15 App Router, React, SWR, shadcn/ui, Tailwind CSS, `useUnifiedWallet` (dapp's canonical wallet hook).

---

### Task 1: Migrate `useSessionKey` → `useUnifiedWallet` in portfolio pages and sweep-bar

**Context:** `src/hooks/use-session-key.ts` is a compatibility shim written to let pages copied from medialane-io compile without changes. It wraps `useUnifiedWallet` and re-exposes its `address` as `walletAddress`. Every portfolio sub-page and `sweep-bar.tsx` only ever uses `walletAddress` from it. We can remove the indirection now.

**Do NOT delete `use-session-key.ts`** — it is still imported by `src/components/launch-mint.tsx` and `src/app/create/` pages which are out of scope.

**Files:**
- Modify: `src/app/portfolio/assets/page.tsx`
- Modify: `src/app/portfolio/listings/page.tsx`
- Modify: `src/app/portfolio/offers/page.tsx`
- Modify: `src/app/portfolio/counter-offers/page.tsx`
- Modify: `src/app/portfolio/received/page.tsx`
- Modify: `src/app/portfolio/activity/page.tsx`
- Modify: `src/app/portfolio/collections/page.tsx`
- Modify: `src/app/portfolio/remix-offers/page.tsx`
- Modify: `src/app/collections/[contract]/collection-page-client.tsx`
- Modify: `src/components/collection/sweep-bar.tsx`

- [ ] **Step 1: Apply the migration pattern to the 8 simple portfolio sub-pages**

The pattern for every file is: remove the `useSessionKey` import, add `useUnifiedWallet`, and rename the destructure. Apply it to `assets`, `listings`, `offers`, `counter-offers`, `received`, `activity`.

```tsx
// REMOVE:
import { useSessionKey } from "@/hooks/use-session-key";
const { walletAddress } = useSessionKey();

// ADD:
import { useUnifiedWallet } from "@/hooks/use-unified-wallet";
const { address: walletAddress } = useUnifiedWallet();
```

For `portfolio/assets/page.tsx` the full result is:
```tsx
"use client";

import { useUnifiedWallet } from "@/hooks/use-unified-wallet";
import { AssetsGrid } from "@/components/portfolio/assets-grid";

export default function PortfolioAssetsPage() {
  const { address: walletAddress } = useUnifiedWallet();
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Your assets</h2>
      </div>
      <AssetsGrid key={walletAddress ?? "no-wallet"} address={walletAddress ?? null} />
    </div>
  );
}
```

For `portfolio/listings/page.tsx`:
```tsx
"use client";

import { useUnifiedWallet } from "@/hooks/use-unified-wallet";
import { ListingsTable } from "@/components/portfolio/listings-table";

export default function PortfolioListingsPage() {
  const { address: walletAddress } = useUnifiedWallet();
  return <ListingsTable address={walletAddress!} />;
}
```

For `portfolio/offers/page.tsx`:
```tsx
"use client";

import { useUnifiedWallet } from "@/hooks/use-unified-wallet";
import { OffersTable } from "@/components/portfolio/offers-table";

export default function PortfolioOffersPage() {
  const { address: walletAddress } = useUnifiedWallet();
  return <OffersTable address={walletAddress!} />;
}
```

For `portfolio/counter-offers/page.tsx`:
```tsx
"use client";

import { useUnifiedWallet } from "@/hooks/use-unified-wallet";
import { CounterOffersTable } from "@/components/portfolio/counter-offers-table";

export default function PortfolioCounterOffersPage() {
  const { address: walletAddress } = useUnifiedWallet();
  return <CounterOffersTable address={walletAddress!} />;
}
```

For `portfolio/received/page.tsx`:
```tsx
"use client";

import { useUnifiedWallet } from "@/hooks/use-unified-wallet";
import { ReceivedOffersTable } from "@/components/portfolio/received-offers-table";

export default function PortfolioReceivedPage() {
  const { address: walletAddress } = useUnifiedWallet();
  return <ReceivedOffersTable address={walletAddress!} />;
}
```

For `portfolio/activity/page.tsx`:
```tsx
"use client";

import { useUnifiedWallet } from "@/hooks/use-unified-wallet";
import { PortfolioActivity } from "@/components/portfolio/portfolio-activity";

export default function PortfolioActivityPage() {
  const { address: walletAddress } = useUnifiedWallet();
  return <PortfolioActivity address={walletAddress ?? null} />;
}
```

- [ ] **Step 2: Migrate `portfolio/collections/page.tsx`**

This file uses `walletAddress` at line 83. The rest of the file (the `CollectionCard` component) is unchanged. Only the hook call changes:

```tsx
// In PortfolioCollectionsPage component body, replace:
const { walletAddress } = useSessionKey();
// With:
const { address: walletAddress } = useUnifiedWallet();
```

Also update the import at the top of the file — remove `useSessionKey`, add `useUnifiedWallet`:
```tsx
// Remove:
import { useSessionKey } from "@/hooks/use-session-key";
// Add:
import { useUnifiedWallet } from "@/hooks/use-unified-wallet";
```

- [ ] **Step 3: Migrate `portfolio/remix-offers/page.tsx`**

Line 16: `const { walletAddress } = useSessionKey();`

Replace:
```tsx
import { useSessionKey } from "@/hooks/use-session-key";
```
With:
```tsx
import { useUnifiedWallet } from "@/hooks/use-unified-wallet";
```

And on line 16:
```tsx
// Remove:
const { walletAddress } = useSessionKey();
// Add:
const { address: walletAddress } = useUnifiedWallet();
```

- [ ] **Step 4: Migrate `collection-page-client.tsx`**

This file has two usages at lines 84 and 240, both `const { walletAddress } = useSessionKey()`.

At line 29, replace:
```tsx
import { useSessionKey } from "@/hooks/use-session-key";
```
With:
```tsx
import { useUnifiedWallet } from "@/hooks/use-unified-wallet";
```

At line 84 (inside `CollectionItems` component):
```tsx
// Remove:
const { walletAddress } = useSessionKey();
// Add:
const { address: walletAddress } = useUnifiedWallet();
```

At line 240 (inside the default export component):
```tsx
// Remove:
const { walletAddress } = useSessionKey();
// Add:
const { address: walletAddress } = useUnifiedWallet();
```

- [ ] **Step 5: Migrate `sweep-bar.tsx`**

At line 8, replace:
```tsx
import { useSessionKey } from "@/hooks/use-session-key";
```
With:
```tsx
import { useUnifiedWallet } from "@/hooks/use-unified-wallet";
```

At line 38:
```tsx
// Remove:
const { walletAddress } = useSessionKey();
// Add:
const { address: walletAddress } = useUnifiedWallet();
```

- [ ] **Step 6: Verify no remaining shim imports in these files**

```bash
grep -rn "useSessionKey" \
  src/app/portfolio \
  src/app/collections \
  src/components/collection/sweep-bar.tsx
```

Expected output: no matches.

- [ ] **Step 7: Commit**

```bash
git add \
  src/app/portfolio/assets/page.tsx \
  src/app/portfolio/listings/page.tsx \
  src/app/portfolio/offers/page.tsx \
  src/app/portfolio/counter-offers/page.tsx \
  src/app/portfolio/received/page.tsx \
  src/app/portfolio/activity/page.tsx \
  src/app/portfolio/collections/page.tsx \
  src/app/portfolio/remix-offers/page.tsx \
  src/app/collections/[contract]/collection-page-client.tsx \
  src/components/collection/sweep-bar.tsx
git commit -m "refactor: replace useSessionKey shim with useUnifiedWallet in portfolio and collection pages"
```

---

### Task 2: Fix portfolio layout — include ERC-1155 listings in stats pill

**Context:** `portfolio/layout.tsx` shows a "Listings" stat pill. The count is computed by filtering `orders` for `offer.itemType === "ERC721"`. ERC-1155 marketplace listings use `offer.itemType === "ERC1155"` — they are currently invisible in the count.

**Files:**
- Modify: `src/app/portfolio/layout.tsx:56`

- [ ] **Step 1: Fix `activeListingsCount`**

In `src/app/portfolio/layout.tsx`, find the line (around line 56–58):
```tsx
const activeListingsCount = orders.filter(
  (o) => o.offer.itemType === "ERC721" && o.status === "ACTIVE"
).length;
```

Replace with:
```tsx
const activeListingsCount = orders.filter(
  (o) =>
    (o.offer.itemType === "ERC721" || o.offer.itemType === "ERC1155") &&
    o.status === "ACTIVE"
).length;
```

- [ ] **Step 2: Commit**

```bash
git add src/app/portfolio/layout.tsx
git commit -m "fix: include ERC-1155 listings in portfolio stats pill count"
```

---

### Task 3: Collections page — add Drops source filter tab

**Context:** `collections-page-client.tsx` has `SOURCE_TABS` with "All" and "POP Events". The backend supports `source=COLLECTION_DROP` as a filter, but users can't reach it from the browse UI. Adding a "Drops" tab mirrors how POP Events is already handled.

**Files:**
- Modify: `src/app/collections/collections-page-client.tsx`

- [ ] **Step 1: Add `Package` to the lucide-react import**

Find the existing lucide import:
```tsx
import { Layers, Loader2, BadgeCheck, Eye, SlidersHorizontal, Award } from "lucide-react";
```

Replace with:
```tsx
import { Layers, Loader2, BadgeCheck, Eye, SlidersHorizontal, Award, Package } from "lucide-react";
```

- [ ] **Step 2: Add Drops to SOURCE_TABS**

Find:
```tsx
const SOURCE_TABS = [
  { label: "All",        value: undefined      },
  { label: "POP Events", value: "POP_PROTOCOL" },
] as const;
```

Replace with:
```tsx
const SOURCE_TABS = [
  { label: "All",    value: undefined           },
  { label: "POP",    value: "POP_PROTOCOL"      },
  { label: "Drops",  value: "COLLECTION_DROP"   },
] as const;
```

- [ ] **Step 3: Fix `hideEmpty` logic for Drops**

Drops collections, like POP collections, may have supply but we still want to show them even if `hideEmpty` is on. Find:
```tsx
source === "POP_PROTOCOL" ? false : hideEmpty,
```

Replace with:
```tsx
(source === "POP_PROTOCOL" || source === "COLLECTION_DROP") ? false : hideEmpty,
```

- [ ] **Step 4: Add Drops filter pill in the toolbar active pills section**

In the toolbar, find the existing POP Events active pill block:
```tsx
{source !== undefined && (
  <span className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border border-primary/40 bg-primary/10 text-primary">
    <Award className="h-3 w-3" />
    POP Events
    <button onClick={() => setSource(undefined)} className="ml-0.5 hover:text-primary/60">×</button>
  </span>
)}
```

Replace with two specific pills (one per source value):
```tsx
{source === "POP_PROTOCOL" && (
  <span className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border border-primary/40 bg-primary/10 text-primary">
    <Award className="h-3 w-3" />
    POP Events
    <button onClick={() => setSource(undefined)} className="ml-0.5 hover:text-primary/60">×</button>
  </span>
)}
{source === "COLLECTION_DROP" && (
  <span className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border border-primary/40 bg-primary/10 text-primary">
    <Package className="h-3 w-3" />
    Drops
    <button onClick={() => setSource(undefined)} className="ml-0.5 hover:text-primary/60">×</button>
  </span>
)}
```

- [ ] **Step 5: Update `activeFilters` badge count**

The badge count is computed as:
```tsx
const totalBadge = activeFilters + (source !== undefined ? 1 : 0);
```

This already handles any non-undefined source value, so no change needed here.

- [ ] **Step 6: Update the Drops filter button in the dialog**

In the dialog's Source section, find the SOURCE_TABS map that renders buttons. The label "POP Events" was shortened to "POP" in Step 2. Verify the `Award` icon still only renders for `POP_PROTOCOL`:

```tsx
{SOURCE_TABS.map(({ label, value }) => (
  <button
    key={label}
    onClick={() => setSource(value)}
    className={cn(
      "flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border transition-colors whitespace-nowrap",
      source === value
        ? "border-primary bg-primary/10 text-primary font-medium"
        : "border-border text-muted-foreground hover:border-primary/50"
    )}
  >
    {value === "POP_PROTOCOL" && <Award className="h-3 w-3" />}
    {value === "COLLECTION_DROP" && <Package className="h-3 w-3" />}
    {label}
  </button>
))}
```

- [ ] **Step 7: Commit**

```bash
git add src/app/collections/collections-page-client.tsx
git commit -m "feat: add Drops source filter tab to collections browse page"
```

---

### Task 4: Creators page — add load-more pagination

**Context:** `creators-client.tsx` calls `useCreators(search, 1, 20)` — page is hardcoded to 1. With more than 20 creators the rest are unreachable. `useCreators` accepts `page` and `limit` params and returns `total`. This task adds the same infinite-append pattern used by the Collections page.

**Files:**
- Modify: `src/app/creators/creators-client.tsx`

- [ ] **Step 1: Add `useEffect` to imports**

Find:
```tsx
import { useState, useRef } from "react";
```

Replace with:
```tsx
import { useState, useRef, useEffect } from "react";
```

- [ ] **Step 2: Add `Loader2` to lucide imports**

Find:
```tsx
import { AtSign, Search, Users, Palette, Globe, Twitter, X } from "lucide-react";
```

Replace with:
```tsx
import { AtSign, Search, Users, Palette, Globe, Twitter, X, Loader2 } from "lucide-react";
```

- [ ] **Step 3: Add pagination state**

In `CreatorsPageClient`, after the existing state declarations:
```tsx
const [search, setSearch] = useState("");
const [debouncedSearch, setDebouncedSearch] = useState("");
const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
```

Add:
```tsx
const [page, setPage] = useState(1);
const [allCreators, setAllCreators] = useState<ApiCreatorProfile[]>([]);
const prevSearch = useRef<string | undefined>(undefined);
```

- [ ] **Step 4: Replace the `useCreators` call to use `page`**

Find:
```tsx
const { creators, total, isLoading } = useCreators(debouncedSearch || undefined);
```

Replace with:
```tsx
const { creators, total, isLoading } = useCreators(debouncedSearch || undefined, page, 20);
```

- [ ] **Step 5: Add effects to reset on search change and accumulate pages**

After the `useCreators` call, add:
```tsx
// Reset accumulated list when search query changes
useEffect(() => {
  if (prevSearch.current !== debouncedSearch) {
    prevSearch.current = debouncedSearch;
    setPage(1);
    setAllCreators([]);
  }
}, [debouncedSearch]);

// Append newly loaded page to the accumulated list
useEffect(() => {
  if (isLoading || creators.length === 0) return;
  setAllCreators((prev) => {
    const seen = new Set(prev.map((c) => c.walletAddress));
    const next = creators.filter((c) => !seen.has(c.walletAddress));
    return page === 1 ? creators : [...prev, ...next];
  });
}, [creators, isLoading, page]);
```

- [ ] **Step 6: Swap `creators` → `allCreators` in the render**

There are three places in the JSX that reference `creators` (the hook result). Replace each with `allCreators`:

1. The `debouncedSearch` result count line:
```tsx
// Before:
{creators.length} result{creators.length !== 1 ? "s" : ""} for &ldquo;{debouncedSearch}&rdquo;
// After:
{allCreators.length} result{allCreators.length !== 1 ? "s" : ""} for &ldquo;{debouncedSearch}&rdquo;
```

2. The Stagger map:
```tsx
// Before:
{creators.map((c) => (
// After:
{allCreators.map((c) => (
```

3. The `isLoading` ternary condition — add an `isInitialLoading` variable so skeletons only show on first page load, not on load-more:
```tsx
const isInitialLoading = isLoading && allCreators.length === 0;
```

Then update the condition:
```tsx
// Before:
{isLoading ? (
// After:
{isInitialLoading ? (
```

Also update the `creators.length > 0` branch check:
```tsx
// Before:
) : creators.length > 0 ? (
// After:
) : allCreators.length > 0 ? (
```

- [ ] **Step 7: Add load-more button**

After the closing `</>` of the `allCreators.length > 0` branch, add a load-more button inside the `<>` fragment, after the `<Stagger>` block:

```tsx
{allCreators.length > 0 ? (
  <>
    {debouncedSearch && (
      <p className="text-sm text-muted-foreground mb-4">
        {allCreators.length} result{allCreators.length !== 1 ? "s" : ""} for &ldquo;{debouncedSearch}&rdquo;
      </p>
    )}
    <Stagger className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {allCreators.map((c) => (
        <StaggerItem key={c.walletAddress}>
          <CreatorCard creator={c} />
        </StaggerItem>
      ))}
    </Stagger>
    {allCreators.length < total && (
      <div className="flex justify-center pt-6">
        <Button
          variant="outline"
          onClick={() => setPage((p) => p + 1)}
          disabled={isLoading}
        >
          {isLoading
            ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Loading…</>
            : `Load more (${total - allCreators.length} remaining)`}
        </Button>
      </div>
    )}
  </>
) : (
```

- [ ] **Step 8: Commit**

```bash
git add src/app/creators/creators-client.tsx
git commit -m "feat: add load-more pagination to creators browse page"
```
