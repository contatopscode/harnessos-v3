// Catalogue for the `?` overlay. Keep in sync with each page's useKeymap.
import type { KeymapGroup } from '../components/KeymapHelp';

export const SHORTCUTS: readonly KeymapGroup[] = [
  {
    title: 'Em qualquer lugar',
    entries: [
      { keys: ['p'], label: 'Escolher um projeto' },
      { keys: ['n'], label: 'Iniciar uma nova execução' },
      { keys: ['a'], label: 'Abrir agentes' },
      { keys: [','], label: 'Abrir configurações' },
      { keys: ['?'], label: 'Mostrar esta ajuda' },
    ],
  },
  {
    title: 'Feed de execuções',
    entries: [
      { keys: ['j'], label: 'Mover seleção para baixo' },
      { keys: ['k'], label: 'Mover seleção para cima' },
      { keys: ['Enter'], label: 'Abrir execução selecionada' },
      { keys: ['Escape'], label: 'Limpar seleção' },
      { keys: ['g', 'g'], label: 'Ir para o início' },
      { keys: ['G'], label: 'Ir para o final' },
      { keys: ['/'], label: 'Focar busca' },
      { keys: ['1'], label: 'Filtro: em execução' },
      { keys: ['2'], label: 'Filtro: pausadas' },
      { keys: ['3'], label: 'Filtro: falharam' },
      { keys: ['4'], label: 'Filtro: concluídas' },
      { keys: ['5'], label: 'Filtro: todas' },
    ],
  },
  {
    title: 'Detalhe da execução',
    entries: [
      { keys: ['1'], label: 'Aba log' },
      { keys: ['2'], label: 'Aba grafo' },
      { keys: ['3'], label: 'Aba artefatos' },
      { keys: ['t'], label: 'Alternar chamadas de ferramenta' },
      { keys: ['s'], label: 'Alternar eventos do sistema' },
      { keys: ['a'], label: 'Aprovar (apenas pausadas)' },
      { keys: ['r'], label: 'Rejeitar (apenas pausadas)' },
      { keys: ['Escape'], label: 'Voltar para execuções' },
      { keys: ['h'], label: 'Voltar para execuções' },
    ],
  },
];
