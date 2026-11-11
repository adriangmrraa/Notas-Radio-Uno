import type { ReactNode } from 'react';

/**
 * ResponsiveTable — contenedor de scroll horizontal para tablas anchas.
 *
 * Cuando la tabla es más ancha que el viewport, el scroll queda contenido
 * acá (nunca en `body`): la tabla conserva su ancho natural (`min-w-*` en
 * el `<table>` hijo) y este wrapper scrollea. `role="region"` + `tabIndex`
 * lo hacen accesible por teclado y lector de pantalla.
 */
interface ResponsiveTableProps {
    /** Nombre accesible de la región scrolleable (ej: "Tabla de personas"). */
    label: string;
    children: ReactNode;
    className?: string;
}

export function ResponsiveTable({ label, children, className }: ResponsiveTableProps) {
    return (
        <div
            role="region"
            aria-label={label}
            tabIndex={0}
            className={`overflow-x-auto ${className ?? ''}`}
        >
            {children}
        </div>
    );
}
