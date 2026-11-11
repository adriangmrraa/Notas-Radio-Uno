// @vitest-environment jsdom
/**
 * PH-05 — hook useAsyncData: ciclo loading → data | error + reload.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useAsyncData } from '../src/client/hooks/useAsyncData';
import { ApiError } from '../src/client/lib/errors';

afterEach(cleanup);

describe('useAsyncData', () => {
  it('arranca en loading y resuelve con data', async () => {
    const loader = vi.fn().mockResolvedValue({ items: [1, 2, 3] });
    const { result } = renderHook(() => useAsyncData(loader, []));

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ items: [1, 2, 3] });
    expect(result.current.error).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('loader que falla ⇒ error clasificado, data null, loading false', async () => {
    const loader = vi.fn().mockRejectedValue(new ApiError('no autorizado', 403));
    const { result } = renderHook(() => useAsyncData(loader, []));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error?.kind).toBe('forbidden');
    expect(result.current.error?.status).toBe(403);
  });

  it('error de red (TypeError) ⇒ kind offline', async () => {
    const loader = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useAsyncData(loader, []));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.kind).toBe('offline');
  });

  it('reload re-ejecuta el loader y limpia el error previo', async () => {
    const loader = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ApiError('down', 500))
      .mockResolvedValue('ok');
    const { result } = renderHook(() => useAsyncData(loader, []));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.kind).toBe('server');

    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.data).toBe('ok');
    expect(result.current.error).toBeNull();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('reload tras error muestra loading de nuevo', async () => {
    const loader = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ApiError('down', 500))
      .mockImplementation(() => new Promise(() => {})); // nunca resuelve
    const { result } = renderHook(() => useAsyncData(loader, []));

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      void result.current.reload();
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(true);
  });

  it('cambio de deps re-ejecuta el loader', async () => {
    const loader = vi.fn().mockResolvedValue('data');
    const { rerender } = renderHook(
      ({ page }) => useAsyncData(loader, [page]),
      { initialProps: { page: 1 } },
    );

    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    rerender({ page: 2 });
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
  });

  it('setData permite mutar localmente sin refetch', async () => {
    const loader = vi.fn().mockResolvedValue(['a']);
    const { result } = renderHook(() => useAsyncData(loader, []));

    await waitFor(() => expect(result.current.data).toEqual(['a']));

    act(() => {
      result.current.setData((prev) => [...(prev ?? []), 'b']);
    });
    expect(result.current.data).toEqual(['a', 'b']);
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
