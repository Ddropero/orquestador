#!/usr/bin/env bash
# Crea el índice vectorial y sus índices de metadatos.
#
# ⚠️ IRREVERSIBLE. Vectorize no aplica un índice de metadatos a los vectores ya
# cargados, y el máximo son 10 por índice. Ejecutar ANTES de la primera carga.
#
# La fuente de verdad del esquema es packages/core/src/vector-metadata.ts.
# Si cambias uno, cambia el otro.
#
#   bash infra/vectorize-setup.sh

set -euo pipefail

INDEX="${1:-evidentia-abstracts}"

echo "▸ Creando índice ${INDEX} (1024 dimensiones = bge-m3, multilingüe)"
npx wrangler vectorize create "$INDEX" --dimensions=1024 --metric=cosine

echo ""
echo "▸ Índices de metadatos — 9 de las 10 ranuras. La décima queda libre a propósito."

# --- Procedencia y calidad ---------------------------------------------------
npx wrangler vectorize create-metadata-index "$INDEX" --propertyName=year      --type=number
npx wrangler vectorize create-metadata-index "$INDEX" --propertyName=design    --type=string
npx wrangler vectorize create-metadata-index "$INDEX" --propertyName=source    --type=string
npx wrangler vectorize create-metadata-index "$INDEX" --propertyName=lang      --type=string
npx wrangler vectorize create-metadata-index "$INDEX" --propertyName=rob       --type=string

# --- Aplicabilidad clínica ---------------------------------------------------
# Estos cuatro son los que permiten juzgar si la evidencia aplica al caso que
# tienes delante. Alimentan directamente el dominio de evidencia indirecta de GRADE.
npx wrangler vectorize create-metadata-index "$INDEX" --propertyName=age       --type=string
npx wrangler vectorize create-metadata-index "$INDEX" --propertyName=region    --type=string
npx wrangler vectorize create-metadata-index "$INDEX" --propertyName=condition --type=string
npx wrangler vectorize create-metadata-index "$INDEX" --propertyName=setting   --type=string

echo ""
echo "✓ Listo. Ranuras usadas: 9/10."
echo ""
echo "  Recuerda: los valores de tipo string solo se indexan hasta 64 bytes."
echo "  Un valor más largo NO falla al insertarse — falla en silencio al filtrarse."
echo "  assertIndexable() en @evidentia/core lo comprueba antes de escribir."
echo ""
npx wrangler vectorize list-metadata-index "$INDEX" || true
