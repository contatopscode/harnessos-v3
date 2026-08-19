import { PagePlaceholder } from '../components/PagePlaceholder';

export function ClientesPage() {
  return (
    <PagePlaceholder
      title="Clientes"
      description="Top-level customer / org registry. Em uma empresa, 1 cliente = 1 razão social; cada codebase (Projeto) e cada demanda pertence a um cliente."
      bullets={[
        'CRUD completo (criar, editar, status active/inactive/archived)',
        'Listar com filtros + busca',
        'Tabela de contatos + e-mails principais',
      ]}
    />
  );
}
