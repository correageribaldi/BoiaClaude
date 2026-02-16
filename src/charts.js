const { ChartJSNodeCanvas } = require('chartjs-node-canvas');

// Configuração padrão dos gráficos
const width = 800;
const height = 600;
const chartCallback = (ChartJS) => {
  ChartJS.defaults.font.family = 'Arial';
  ChartJS.defaults.font.size = 14;
};

/**
 * Gera gráfico de pizza com despesas por categoria
 */
async function gerarGraficoCategorias(dadosResumo) {
  const { porCategoria, mes, ano } = dadosResumo;

  if (!porCategoria || porCategoria.length === 0) {
    return null; // Sem dados para gráfico
  }

  // Filtrar apenas despesas e ordenar por valor
  const despesas = porCategoria
    .filter(c => c.tipo === 'despesa')
    .sort((a, b) => b.total - a.total);

  if (despesas.length === 0) {
    return null;
  }

  const categorias = despesas.map(c => c.categoria);
  const valores = despesas.map(c => c.total);

  // Cores vibrantes para as categorias
  const cores = [
    '#FF6384', // Rosa
    '#36A2EB', // Azul
    '#FFCE56', // Amarelo
    '#4BC0C0', // Verde água
    '#9966FF', // Roxo
    '#FF9F40', // Laranja
    '#FF6384', // Rosa (repete)
    '#C9CBCF', // Cinza
  ];

  const meses = ['', 'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
                 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

  const chartCanvas = new ChartJSNodeCanvas({
    width,
    height,
    chartCallback
  });

  const configuration = {
    type: 'pie',
    data: {
      labels: categorias,
      datasets: [{
        data: valores,
        backgroundColor: cores.slice(0, categorias.length),
        borderColor: '#ffffff',
        borderWidth: 2
      }]
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: `Despesas por Categoria - ${meses[mes]}/${ano}`,
          font: {
            size: 24,
            weight: 'bold'
          },
          padding: {
            top: 10,
            bottom: 20
          }
        },
        legend: {
          position: 'right',
          labels: {
            font: {
              size: 14
            },
            padding: 15,
            generateLabels: (chart) => {
              const data = chart.data;
              if (data.labels.length && data.datasets.length) {
                return data.labels.map((label, i) => {
                  const value = data.datasets[0].data[i];
                  const total = data.datasets[0].data.reduce((a, b) => a + b, 0);
                  const percentage = ((value / total) * 100).toFixed(1);
                  return {
                    text: `${label} - ${percentage}%`,
                    fillStyle: data.datasets[0].backgroundColor[i],
                    hidden: false,
                    index: i
                  };
                });
              }
              return [];
            }
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              const label = context.label || '';
              const value = context.parsed || 0;
              return `${label}: R$ ${value.toFixed(2).replace('.', ',')}`;
            }
          }
        }
      }
    },
    plugins: [{
      id: 'background',
      beforeDraw: (chart) => {
        const ctx = chart.ctx;
        ctx.save();
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, chart.width, chart.height);
        ctx.restore();
      }
    }]
  };

  try {
    const imageBuffer = await chartCanvas.renderToBuffer(configuration);
    console.log('[CHART] Gráfico de categorias gerado com sucesso');
    return imageBuffer;
  } catch (err) {
    console.error('[CHART] Erro ao gerar gráfico:', err.message);
    return null;
  }
}

/**
 * Gera gráfico de barras com receitas vs despesas
 */
async function gerarGraficoReceitasDespesas(dadosResumo) {
  const { totais, mes, ano } = dadosResumo;

  if (!totais || totais.length === 0) {
    return null;
  }

  // Agregar totais por tipo
  let receitasTotal = 0;
  let despesasTotal = 0;

  for (const t of totais) {
    if (t.tipo === 'receita') {
      receitasTotal += t.total;
    } else if (t.tipo === 'despesa') {
      despesasTotal += t.total;
    }
  }

  if (receitasTotal === 0 && despesasTotal === 0) {
    return null;
  }

  const meses = ['', 'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
                 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

  const chartCanvas = new ChartJSNodeCanvas({
    width,
    height: 500,
    chartCallback
  });

  const configuration = {
    type: 'bar',
    data: {
      labels: ['Receitas', 'Despesas'],
      datasets: [{
        label: 'Valor (R$)',
        data: [receitasTotal, despesasTotal],
        backgroundColor: [
          'rgba(75, 192, 192, 0.8)', // Verde para receitas
          'rgba(255, 99, 132, 0.8)'  // Vermelho para despesas
        ],
        borderColor: [
          'rgba(75, 192, 192, 1)',
          'rgba(255, 99, 132, 1)'
        ],
        borderWidth: 2
      }]
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: `Receitas vs Despesas - ${meses[mes]}/${ano}`,
          font: {
            size: 24,
            weight: 'bold'
          },
          padding: {
            top: 10,
            bottom: 20
          }
        },
        legend: {
          display: false
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              const value = context.parsed.y || 0;
              return `R$ ${value.toFixed(2).replace('.', ',')}`;
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback: function(value) {
              return 'R$ ' + value.toFixed(0);
            }
          }
        }
      }
    },
    plugins: [{
      id: 'background',
      beforeDraw: (chart) => {
        const ctx = chart.ctx;
        ctx.save();
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, chart.width, chart.height);
        ctx.restore();
      }
    }]
  };

  try {
    const imageBuffer = await chartCanvas.renderToBuffer(configuration);
    console.log('[CHART] Gráfico de receitas vs despesas gerado com sucesso');
    return imageBuffer;
  } catch (err) {
    console.error('[CHART] Erro ao gerar gráfico:', err.message);
    return null;
  }
}

/**
 * Gera gráfico de barras horizontais para análise 50/30/20
 * dados: { necessidades: { real, meta }, desejos: { real, meta }, poupanca: { real, meta } }
 */
async function gerarGrafico503020(dados) {
  const { necessidades, desejos, poupanca } = dados;

  const chartCanvas = new ChartJSNodeCanvas({
    width: 800,
    height: 500,
    chartCallback
  });

  const labels = ['🏠 Necessidades (50%)', '🎯 Desejos (30%)', '💰 Poupança (20%)'];
  const reais = [necessidades.real, desejos.real, poupanca.real];
  const metas = [necessidades.meta, desejos.meta, poupanca.meta];

  // Cores: verde se dentro da meta, vermelho se acima (necessidades/desejos), amarelo se abaixo (poupança)
  const coresReais = [
    necessidades.real <= necessidades.meta ? 'rgba(75, 192, 192, 0.85)' : 'rgba(255, 99, 132, 0.85)',
    desejos.real <= desejos.meta ? 'rgba(75, 192, 192, 0.85)' : 'rgba(255, 99, 132, 0.85)',
    poupanca.real >= poupanca.meta ? 'rgba(75, 192, 192, 0.85)' : 'rgba(255, 206, 86, 0.85)',
  ];

  const configuration = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Realizado',
          data: reais,
          backgroundColor: coresReais,
          borderColor: coresReais.map(c => c.replace('0.85', '1')),
          borderWidth: 2,
        },
        {
          label: 'Meta',
          data: metas,
          backgroundColor: 'rgba(200, 200, 200, 0.5)',
          borderColor: 'rgba(150, 150, 150, 0.8)',
          borderWidth: 2,
          borderDash: [5, 5],
        }
      ]
    },
    options: {
      indexAxis: 'y',
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: 'Análise Financeira - Regra 50/30/20',
          font: { size: 22, weight: 'bold' },
          padding: { top: 10, bottom: 20 }
        },
        legend: {
          position: 'top',
          labels: { font: { size: 14 }, padding: 15 }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              const value = context.parsed.x || 0;
              return `${context.dataset.label}: R$ ${value.toFixed(2).replace('.', ',')}`;
            }
          }
        }
      },
      scales: {
        x: {
          beginAtZero: true,
          ticks: {
            callback: function(value) {
              return 'R$ ' + value.toFixed(0);
            }
          }
        },
        y: {
          ticks: { font: { size: 14 } }
        }
      }
    },
    plugins: [{
      id: 'background',
      beforeDraw: (chart) => {
        const ctx = chart.ctx;
        ctx.save();
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, chart.width, chart.height);
        ctx.restore();
      }
    }]
  };

  try {
    const imageBuffer = await chartCanvas.renderToBuffer(configuration);
    console.log('[CHART] Gráfico 50/30/20 gerado com sucesso');
    return imageBuffer;
  } catch (err) {
    console.error('[CHART] Erro ao gerar gráfico 50/30/20:', err.message);
    return null;
  }
}

module.exports = {
  gerarGraficoCategorias,
  gerarGraficoReceitasDespesas,
  gerarGrafico503020
};
