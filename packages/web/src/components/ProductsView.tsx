// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState } from "react";

export type ProductRow = {
  id: string;
  customer: string;
  projectPath: string;
  sist_renset: string | null;
  productName: string;
  needs_guide: boolean;
  contactName: string;
  contactPhone: string;
  projectDescription?: string | null;
  productDescription?: string | null;
};

export type ProductAction = "register" | "register-products-only" | "edit";

type ProductsViewProps = {
  products?: ProductRow[];
  loading?: boolean;
  error?: string | null;
  onAction?: (action: ProductAction, product: ProductRow) => void;
};

function formatDate(value: string | null): string {
  if (!value) return "Ikke renset";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("nb-NO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function phoneHref(phone: string): string {
  return `tel:${phone.replace(/[^+\d]/g, "")}`;
}

function ProductActions({ product, onAction }: { product: ProductRow; onAction?: ProductsViewProps["onAction"] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const act = (action: ProductAction) => {
    setOpen(false);
    onAction?.(action, product);
  };

  return (
    <div className="product-split" ref={rootRef}>
      <button className="btn primary sm product-split-main" type="button" onClick={() => act("register")}>
        Registrer
      </button>
      <button
        className="btn primary sm product-split-toggle"
        type="button"
        aria-label={`Flere valg for ${product.productName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="menu product-action-menu" role="menu">
          <button className="menu-item" role="menuitem" type="button" onClick={() => act("register-products-only")}>
            Kun varer
          </button>
          <button className="menu-item" role="menuitem" type="button" onClick={() => act("edit")}>
            Endre
          </button>
        </div>
      )}
    </div>
  );
}

export function ProductsView({ products = [], loading = false, error = null, onAction }: ProductsViewProps) {
  return (
    <main className="products-view">
      <header className="products-header">
        <div>
          <p className="products-eyebrow">Oversikt</p>
          <h1>Produkter</h1>
          <p className="products-summary">{products.length} {products.length === 1 ? "produkt" : "produkter"}</p>
        </div>
        <div className="badge" data-tone="accent" data-variant="soft" aria-label="Valgt visning: tabell">
          Tabell
        </div>
      </header>

      {error && <div className="card products-message" data-tone="danger" role="alert">Kunne ikke laste produkter: {error}</div>}

      <div className="products-table-frame" aria-busy={loading}>
        <table className="products-table">
          <caption className="sr-only">Produktoversikt i tabellvisning</caption>
          <thead>
            <tr>
              <th scope="col">Registrer</th>
              <th scope="col">Kunde</th>
              <th scope="col">Prosjekt</th>
              <th scope="col">Sist renset</th>
              <th scope="col">Produkt</th>
              <th scope="col">Trenger guide</th>
              <th scope="col">Kontakt</th>
              <th scope="col">Beskrivelse</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <tr key={product.id}>
                <td><ProductActions product={product} onAction={onAction} /></td>
                <td className="product-customer">{product.customer}</td>
                <td><span className="product-path" title={product.projectPath}>{product.projectPath}</span></td>
                <td><time dateTime={product.sist_renset ?? undefined}>{formatDate(product.sist_renset)}</time></td>
                <td className="product-name">{product.productName}</td>
                <td>
                  <span className="badge" data-tone={product.needs_guide ? "warn" : "ok"} data-variant="soft">
                    {product.needs_guide ? "Ja" : "Nei"}
                  </span>
                </td>
                <td>
                  <span className="product-contact-name">{product.contactName}</span>
                  <a className="product-phone" href={phoneHref(product.contactPhone)} aria-label={`Ring ${product.contactName} på ${product.contactPhone}`}>
                    {product.contactPhone}
                  </a>
                </td>
                <td>
                  <div className="product-descriptions">
                    {product.projectDescription && <p><span>Prosjekt</span>{product.projectDescription}</p>}
                    {product.productDescription && <p><span>Produkt</span>{product.productDescription}</p>}
                    {!product.projectDescription && !product.productDescription && <span className="product-empty-value">Ingen beskrivelse</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {loading && <div className="products-empty" role="status">Laster produkter …</div>}
        {!loading && !error && products.length === 0 && (
          <div className="products-empty">
            <strong>Ingen produkter</strong>
            <span>Produkter vises her når de er lagt til.</span>
          </div>
        )}
      </div>
    </main>
  );
}
