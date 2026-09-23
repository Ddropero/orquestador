/**
 * Límites de tasa con el enlace nativo de Cloudflare (por ubicación y aproximado).
 *
 * Las cifras asumen lo peor del auditorio: cientos de celulares detrás de la misma
 * IP pública del hotel o del NAT del operador móvil. Un límite pensado para "un
 * usuario, una IP" dejaría fuera a medio público en el momento del QR.
 *
 * Si el limitador falla, se deja pasar: en una charla en vivo, un limitador caído
 * no puede tumbar /vivo. La autenticación sigue protegiendo lo que cuesta dinero.
 */
export async function permitido(limitador: RateLimit | undefined, clave: string): Promise<boolean> {
  if (!limitador) return true;
  try {
    const { success } = await limitador.limit({ key: clave });
    return success;
  } catch {
    return true;
  }
}

export function ipDe(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? 'sin-ip';
}
