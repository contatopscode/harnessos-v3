import { PagePlaceholder } from '../components/PagePlaceholder';

export function PipelinesPage() {
  return (
    <PagePlaceholder
      title="Pipelines"
      description="Catalog de pipelines reutilizáveis (workflows do HarnessOS que podem ser associados a uma ou mais demandas). Ex: fsw, planejador-viagem, ecommerce-becker-sync, etc."
      bullets={[
        'Lista de pipelines detectados (do diretório workflows/)',
        'Editor visual de steps (read-only no PR2)',
        'Contadores: quantas demandas usam cada pipeline',
      ]}
    />
  );
}
