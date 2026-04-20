/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { Activity, Zap, Settings2, RotateCcw, Lock, MoveHorizontal, MoveVertical, Maximize, Shuffle } from 'lucide-react';
import { NeuronSim, SimulationParams, SimulationState, SynapseParams } from '@/src/lib/neuron-sim';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import * as RadioGroup from '@radix-ui/react-radio-group';
import * as Switch from '@radix-ui/react-switch';

const MAX_DATA_POINTS = 10000; // 1.0s at 0.1ms resolution

function seededRandom(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  const x = Math.sin(hash) * 10000;
  return x - Math.floor(x);
}

const INITIAL_PARAMS: SimulationParams = {
  excitatory: {
    numSynapses: 169,
    frequency: 3,
    weight: 0.4,
    tau: 2.5,
    distance: 50,
    slope: 55,
    isExcitatory: false,
    isAdaptationEnabled: false,
  },
  inhibitory: {
    numSynapses: 169,
    frequency: 3,
    weight: 0.1,
    tau: 2.5,
    distance: 50,
    slope: 55,
    isExcitatory: true,
    isAdaptationEnabled: false,
  },
  spikeThreshold: -55,
  inhReversalPotential: -90,
  ahpWeight: 40,
  ahpTau: 150,
};

export default function App() {
  const [studentId, setStudentId] = useState('');
  const [confirmStudentId, setConfirmStudentId] = useState('');
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [error, setError] = useState('');

  const [params, setParams] = useState<SimulationParams>(INITIAL_PARAMS);
  
  type MotionType = 'horizontal' | 'vertical' | 'looming' | 'slowLooming';
  const [motionType, setMotionType] = useState<MotionType>('horizontal');
  const [isReversed, setIsReversed] = useState(false);
  const [baseRadius, setBaseRadius] = useState(8);

  const stimSettingsRef = useRef({ motionType, isReversed, baseRadius, params });
  useEffect(() => { 
    stimSettingsRef.current = { motionType, isReversed, baseRadius, params }; 
  }, [motionType, isReversed, baseRadius, params]);

  const [currentVm, setCurrentVm] = useState(-70);
  const [data, setData] = useState<SimulationState[]>([]);
  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);

  const [isPaused, setIsPaused] = useState(false);
  const [yMax, setYMax] = useState(0);
  const [scrollSpeed, setScrollSpeed] = useState(3);
  
  const leftCanvasRef = useRef<HTMLCanvasElement>(null);
  const onCanvasRef = useRef<HTMLCanvasElement>(null);
  const offCanvasRef = useRef<HTMLCanvasElement>(null);
  const chartCanvasRef = useRef<HTMLCanvasElement>(null);
  
  const prevConvRef = useRef<number[]>(new Array(169).fill(255));
  const onActivityRef = useRef<number[]>(new Array(169).fill(0));
  const offActivityRef = useRef<number[]>(new Array(169).fill(0));
  const simRef = useRef<NeuronSim>(new NeuronSim());
  const requestRef = useRef<number | null>(null);
  const animRequestRef = useRef<number | null>(null);

  const lastSimTimeRef = useRef<number>(0);
  const stimPhaseRef = useRef<{ x: number, y: number, r: number }>({ x: 0, y: 14, r: 8 });

  // Animation Loop
  useEffect(() => {
    if (!isAuthorized) return;
    
    const render = () => {
      const curData = dataRef.current;
      const settings = stimSettingsRef.current;
      const currentSimTime = (curData && curData.length > 0) ? curData[curData.length - 1].time : 0;
      
      // Calculate dt based on simulation time advancement
      const dt = Math.max(0, currentSimTime - lastSimTimeRef.current);
      const hasTimeAdvanced = dt > 0;
      lastSimTimeRef.current = currentSimTime;
      
      const wrap = (v: number, m: number) => ((v % m) + m) % m;
      const SPEED_PX_PER_MS = 28 / 1000;
      const RADIAL_SPEED_PX_PER_MS = 5 / 1000;

      const dir = settings.isReversed ? -1 : 1;

      // Update phases by integrating velocity
      if (settings.motionType === 'horizontal') {
        stimPhaseRef.current.x = wrap(stimPhaseRef.current.x + (dt * SPEED_PX_PER_MS * dir), 28);
      } else if (settings.motionType === 'vertical') {
        stimPhaseRef.current.y = wrap(stimPhaseRef.current.y + (dt * SPEED_PX_PER_MS * dir), 28);
      } else if (settings.motionType === 'looming' || settings.motionType === 'slowLooming') {
        const s = settings.motionType === 'looming' ? RADIAL_SPEED_PX_PER_MS : RADIAL_SPEED_PX_PER_MS / 2;
        const range = 14;
        stimPhaseRef.current.r = wrap(stimPhaseRef.current.r + (dt * s * dir), 2 * range);
      }

      let centerX = 14;
      let centerY = 14;
      let currentRadius = settings.baseRadius;

      if (settings.motionType === 'horizontal') {
        centerX = stimPhaseRef.current.x;
      } else if (settings.motionType === 'vertical') {
        centerY = stimPhaseRef.current.y;
      } else if (settings.motionType === 'looming' || settings.motionType === 'slowLooming') {
        const range = 14;
        currentRadius = stimPhaseRef.current.r > range ? 2 * range - stimPhaseRef.current.r : stimPhaseRef.current.r;
        currentRadius = Math.max(0.1, currentRadius);
      }

      const stimulusMap = new Array(28 * 28).fill(255);
      const rSq = Math.pow(currentRadius, 2);
      for (let y = 0; y < 28; y++) {
        for (let x = 0; x < 28; x++) {
          let isInside = false;
          for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
              const distSq = Math.pow(x - (centerX + dx * 28), 2) + Math.pow(y - (centerY + dy * 28), 2);
              if (distSq <= rSq) { isInside = true; break; }
            }
            if (isInside) break;
          }
          if (isInside) stimulusMap[y * 28 + x] = 0;
        }
      }

      const leftCanvas = leftCanvasRef.current;
      if (leftCanvas) {
        const ctx = leftCanvas.getContext('2d');
        if (ctx) {
          const img = ctx.createImageData(28, 28);
          for (let i = 0; i < 784; i++) {
            const v = stimulusMap[i];
            const idx = i * 4;
            img.data[idx] = v; img.data[idx+1] = v; img.data[idx+2] = v; img.data[idx+3] = 255;
          }
          ctx.putImageData(img, 0, 0);
        }
      }

      const currentConv = new Array(169).fill(0);
      for (let x = 0; x < 13; x++) {
        for (let y = 0; y < 13; y++) {
          let sum = 0;
          for (let ky = 0; ky < 3; ky++) {
            for (let kx = 0; kx < 3; kx++) {
              const idx = (y * 2 + ky) * 28 + (x * 2 + kx);
              sum += (idx >= 0 && idx < 784) ? stimulusMap[idx] : 255;
            }
          }
          currentConv[x * 13 + y] = sum / 9;
        }
      }

      const onCanvas = onCanvasRef.current;
      const offCanvas = offCanvasRef.current;
      if (onCanvas && offCanvas) {
        const onCtx = onCanvas.getContext('2d');
        const offCtx = offCanvas.getContext('2d');
        if (onCtx && offCtx) {
          const onImg = onCtx.createImageData(13, 13);
          const offImg = offCtx.createImageData(13, 13);
          const isAdaptationL1 = settings.params.inhibitory.isAdaptationEnabled;
          const isAdaptationL2 = settings.params.excitatory.isAdaptationEnabled;
          const INTEGRATION = 0.85;
          const T_GAIN = 100;
          const S_GAIN = 0.5;

          for (let i = 0; i < 169; i++) {
            const diff = hasTimeAdvanced ? (currentConv[i] - prevConvRef.current[i]) : 0;
            let targetOn = isAdaptationL1 ? Math.max(0, diff * T_GAIN) : currentConv[i] * S_GAIN;
            let targetOff = isAdaptationL2 ? Math.max(0, -diff * T_GAIN) : (255 - currentConv[i]) * S_GAIN;

            onActivityRef.current[i] = onActivityRef.current[i] * INTEGRATION + targetOn * (1 - INTEGRATION);
            offActivityRef.current[i] = offActivityRef.current[i] * INTEGRATION + targetOff * (1 - INTEGRATION);
            
            const x = Math.floor(i / 13); const y = i % 13; const cIdx = (y * 13 + x) * 4;
            onImg.data[cIdx] = Math.min(255, onActivityRef.current[i]); onImg.data[cIdx+3] = 255;
            offImg.data[cIdx+1] = Math.min(255, offActivityRef.current[i]); offImg.data[cIdx+3] = 255;
          }
          if (hasTimeAdvanced) { 
            prevConvRef.current = [...currentConv]; 
          }
          onCtx.putImageData(onImg, 0, 0); offCtx.putImageData(offImg, 0, 0);
        }
      }

      const chartCanvas = chartCanvasRef.current;
      if (chartCanvas && curData.length > 0) {
        const ctx = chartCanvas.getContext('2d');
        if (ctx) {
          const w = chartCanvas.clientWidth; const h = chartCanvas.clientHeight;
          if (chartCanvas.width !== w || chartCanvas.height !== h) {
             chartCanvas.width = w; chartCanvas.height = h;
          }
          const margin = { top: 20, right: 30, bottom: 40, left: 60 };
          const xScale = d3.scaleLinear().domain([0, MAX_DATA_POINTS]).range([margin.left, w - margin.right]);
          const yScale = d3.scaleLinear().domain([-95, yMax || 0]).range([h - margin.bottom, margin.top]);
          const rasterY = d3.scaleLinear().domain([0, 169]).range([h - margin.bottom, margin.top]);

          ctx.clearRect(0, 0, w, h);
          ctx.strokeStyle = '#333'; ctx.globalAlpha = 0.2; ctx.beginPath();
          for(let i=0; i<=10; i++) { 
            const gx = xScale(i * 1000); ctx.moveTo(gx, margin.top); ctx.lineTo(gx, h - margin.bottom); 
          }
          ctx.stroke();

          ctx.globalAlpha = 0.8; ctx.lineWidth = 1.0;
          ctx.strokeStyle = '#22c55e'; // L2
          ctx.beginPath();
          for (let i = 0; i < curData.length; i++) {
            const xPos = xScale(i);
            for (const s of curData[i].spikes) {
              if (s.populationId === 2) {
                const yPos = rasterY(s.index || 0);
                ctx.moveTo(xPos, yPos - 1.5); ctx.lineTo(xPos, yPos + 1.5);
              }
            }
          }
          ctx.stroke();

          ctx.strokeStyle = '#f59e0b'; // L1 (Amber)
          ctx.beginPath();
          for (let i = 0; i < curData.length; i++) {
            const xPos = xScale(i);
            for (const s of curData[i].spikes) {
              if (s.populationId === 1) {
                const yPos = rasterY(s.index || 0);
                ctx.moveTo(xPos, yPos - 1.5); ctx.lineTo(xPos, yPos + 1.5);
              }
            }
          }
          ctx.stroke();

          ctx.setLineDash([4, 4]); ctx.globalAlpha = 0.5;
          ctx.strokeStyle = '#f59e0b'; ctx.beginPath(); ctx.moveTo(margin.left, yScale(-70)); ctx.lineTo(w - margin.right, yScale(-70)); ctx.stroke();
          ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.moveTo(margin.left, yScale(params.spikeThreshold)); ctx.lineTo(w - margin.right, yScale(params.spikeThreshold)); ctx.stroke();
          ctx.setLineDash([]);

          ctx.globalAlpha = 1; ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 2; ctx.beginPath();
          for (let i = 0; i < curData.length; i++) {
            const xp = xScale(i); const yp = yScale(curData[i].vmSoma);
            if (i === 0) ctx.moveTo(xp, yp); else ctx.lineTo(xp, yp);
          }
          ctx.stroke();

          ctx.fillStyle = '#fff'; ctx.font = '20px JetBrains Mono, monospace'; ctx.textAlign = 'center';
          for(let i=0; i<=10; i+=2) { 
            ctx.fillText(`${(i/10).toFixed(1)}s`, xScale(i*1000), h - margin.bottom + 30); 
          }
          ctx.fillStyle = '#3b82f6'; ctx.textAlign = 'right';
          d3.range(Math.floor(-90/10)*10, (yMax||0) + 10, 10).forEach(t => { 
            ctx.fillText(`${t}`, margin.left - 10, yScale(t) + 6); 
          });
        }
      }
      animRequestRef.current = requestAnimationFrame(render);
    };
    animRequestRef.current = requestAnimationFrame(render);
    return () => { if (animRequestRef.current) cancelAnimationFrame(animRequestRef.current); };
  }, [isAuthorized, yMax, params.spikeThreshold]);

  useEffect(() => {
    simRef.current.reset(params);
  }, []);

  useEffect(() => {
    const animate = () => {
      if (!isPaused && isAuthorized) {
        let allNewStates: SimulationState[] = [];
        const coupledParams = {
          ...params,
          excitatory: { ...params.excitatory, inputActivity: offActivityRef.current },
          inhibitory: { ...params.inhibitory, inputActivity: onActivityRef.current }
        };
        for (let i = 0; i < scrollSpeed; i++) {
          allNewStates = [...allNewStates, ...simRef.current.step(coupledParams)];
        }
        const newData = [...dataRef.current, ...allNewStates];
        dataRef.current = newData.length > MAX_DATA_POINTS ? newData.slice(newData.length - MAX_DATA_POINTS) : newData;
        if (Math.random() < 0.2) { setData([...dataRef.current]); setCurrentVm(simRef.current.getVmSoma()); }
      }
      requestRef.current = requestAnimationFrame(animate);
    };
    requestRef.current = requestAnimationFrame(animate);
    return () => { if (requestRef.current) cancelAnimationFrame(requestRef.current); };
  }, [params, isPaused, scrollSpeed, isAuthorized]);

  const updateParam = (pop: 'excitatory' | 'inhibitory', key: keyof SynapseParams, val: any) => {
    const activeVal = Array.isArray(val) ? val[0] : val;
    setParams(p => {
      const newPopParams = { ...p[pop], [key]: activeVal };
      
      // If setting isExcitatory, automatically update weight
      if (key === 'isExcitatory') {
        newPopParams.weight = activeVal ? 0.1 : 0.4;
      }
      
      return {
        ...p,
        [pop]: newPopParams
      };
    });
  };

  const handleLogin = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setError('');

    if (studentId !== confirmStudentId) {
      setError('Student IDs do not match.');
      return;
    }

    if (studentId.length !== 9 || !/^\d+$/.test(studentId)) {
      setError('Please enter a valid 9-digit Student ID.');
      return;
    }

    const rand = seededRandom(studentId);
    setParams(prev => ({ ...prev, inhReversalPotential: -86 - Math.floor(rand * 10) }));
    setIsAuthorized(true);
  };

  if (!isAuthorized) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4 font-sans">
        <Card className="w-full max-w-md bg-zinc-900 border-zinc-800 shadow-2xl">
          <CardHeader className="space-y-1 text-center">
            <CardTitle className="text-2xl font-bold text-zinc-50">Student Gateway</CardTitle>
            <CardDescription className="text-zinc-400 text-sm">Enter your 9-digit Student ID to access the simulator.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label className="text-xs text-zinc-500 uppercase tracking-wider font-bold">Student ID</Label>
                <Input type="password" placeholder="000000000" value={studentId} onChange={(e) => setStudentId(e.target.value)} className="bg-zinc-800 border-zinc-700" />
              </div>
              <div className="space-y-2">
                <Label className="text-xs text-zinc-500 uppercase tracking-wider font-bold">Confirm Student ID</Label>
                <Input type="password" placeholder="000000000" value={confirmStudentId} onChange={(e) => setConfirmStudentId(e.target.value)} className="bg-zinc-800 border-zinc-700" />
              </div>
              {error && (
                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-md text-red-400 text-xs font-medium">
                  {error}
                </div>
              )}
              <Button type="submit" className="w-full bg-blue-600 font-semibold py-6">Enter Simulator</Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-100 p-4 md:p-8 font-sans selection:bg-blue-500/30">
      <div className="max-w-7xl mx-auto space-y-8">
        <header className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-zinc-800 pb-6">
          <div>
            <h1 className="text-4xl font-bold tracking-tight text-zinc-50">Synaptic Integration Simulator</h1>
          </div>
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={() => setIsPaused(!isPaused)} className="bg-zinc-100 text-black">{isPaused ? "Resume" : "Pause"}</Button>
            <Button size="sm" onClick={() => { simRef.current.reset(params); dataRef.current = []; setIsPaused(false); }} className="bg-zinc-800 border-zinc-700">Restart</Button>
            <Button size="sm" onClick={() => { setParams(INITIAL_PARAMS); simRef.current.reset(INITIAL_PARAMS); dataRef.current = []; setIsPaused(false); }} className="bg-zinc-100 text-black">Restore Defaults</Button>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          <div className="lg:col-span-8 space-y-6">
            <Card className="bg-zinc-900 border-zinc-800">
              <CardHeader className="bg-zinc-900/30">
                <CardTitle className="text-lg font-medium flex items-center gap-2">Membrane Potential (Vm)</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="h-[600px] w-full relative">
                  <canvas ref={chartCanvasRef} className="w-full h-full" />
                </div>
              </CardContent>
            </Card>

            <Card className="bg-zinc-900 border-zinc-800">
              <CardContent className="p-6">
                <div className="flex justify-center items-center gap-8">
                  <div className="flex flex-col items-center gap-2">
                    <span className="text-[10px] text-white font-bold">PHOTORECEPTORS</span>
                    <canvas ref={leftCanvasRef} width={28} height={28} className="w-32 h-32 image-pixelated border border-zinc-700" />
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <span className="text-[10px] text-amber-500 font-semibold">L1 NEURONS</span>
                    <canvas ref={onCanvasRef} width={13} height={13} className="w-32 h-32 image-pixelated border border-zinc-700" />
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <span className="text-[10px] text-green-500 font-semibold">L2 NEURONS</span>
                    <canvas ref={offCanvasRef} width={13} height={13} className="w-32 h-32 image-pixelated border border-zinc-700" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="lg:col-span-4 space-y-6">
            <Card className="bg-zinc-900 border-zinc-800">
              <CardHeader><CardTitle className="text-blue-400">Stimulus Control</CardTitle></CardHeader>
              <StimulusControls motionType={motionType} setMotionType={setMotionType} isReversed={isReversed} setIsReversed={setIsReversed} baseRadius={baseRadius} setBaseRadius={setBaseRadius} />
            </Card>

            <Card className="bg-zinc-900 border-zinc-800">
              <CardHeader><CardTitle className="text-green-500">L2 Neurons (Darkening)</CardTitle></CardHeader>
              <SynapseControls params={params.excitatory} onChange={(key, val) => updateParam('excitatory', key, val)} color="green" />
            </Card>

            <Card className="bg-zinc-900 border-zinc-800">
              <CardHeader><CardTitle className="text-amber-500">L1 Neurons (Brightening)</CardTitle></CardHeader>
              <SynapseControls params={params.inhibitory} onChange={(key, val) => updateParam('inhibitory', key, val)} color="amber" />
            </Card>

            <Card className="bg-zinc-900 border-zinc-800 p-6 space-y-6">
              <div className="space-y-3 pb-4 border-b border-zinc-800">
                <div className="flex justify-between items-center text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                  <span>Conductance Monitor</span>
                  <span>nS</span>
                </div>
                
                <div className="space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-green-400">Excitatory (L2)</span>
                    <span className="font-mono">{(data[data.length - 1]?.excConductance * 1e9 || 0) > 0 ? (data[data.length - 1]?.excConductance * 1e9 || 0).toFixed(2) : '0.00'}</span>
                  </div>
                  <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-green-500 transition-all duration-100"
                      style={{ width: `${Math.min(100, (data[data.length - 1]?.excConductance * 1e9 || 0) * 10)}%` }}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-amber-400">Inhibitory (L1)</span>
                    <span className="font-mono">{(data[data.length - 1]?.inhConductance * 1e9 || 0) > 0 ? (data[data.length - 1]?.inhConductance * 1e9 || 0).toFixed(2) : '0.00'}</span>
                  </div>
                  <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-amber-500 transition-all duration-100"
                      style={{ width: `${Math.min(100, (data[data.length - 1]?.inhConductance * 1e9 || 0) * 10)}%` }}
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <div className="flex justify-between items-center text-zinc-300">
                   <Label>Spike Threshold (mV)</Label>
                   <span className="text-yellow-500 font-mono text-sm">{params.spikeThreshold} mV</span>
                </div>
                <Slider value={[params.spikeThreshold]} min={-60} max={0} step={1} onValueChange={(val) => setParams(p => ({ ...p, spikeThreshold: val[0] }))} />
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

function StimulusControls({ motionType, setMotionType, isReversed, setIsReversed, baseRadius, setBaseRadius }: any) {
  return (
    <CardContent className="space-y-6">
      <div className="space-y-4">
        <Label className="text-zinc-400 text-xs font-bold uppercase">Motion Type</Label>
        <RadioGroup.Root className="grid grid-cols-2 gap-2" value={motionType} onValueChange={(val) => setMotionType(val as any)}>
          {['horizontal', 'vertical', 'looming', 'slowLooming'].map((id) => (
            <RadioGroup.Item key={id} value={id} className={`p-3 rounded-md border text-xs font-medium transition-all ${motionType === id ? 'bg-blue-600/20 border-blue-500 text-blue-400' : 'bg-zinc-800/50 border-zinc-700 text-zinc-400'}`}>
              {id.charAt(0).toUpperCase() + id.slice(1)}
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
      </div>

      <div className="space-y-4">
        <Label className="text-zinc-400 text-xs font-bold uppercase">Stimulus Size</Label>
        <div className="grid grid-cols-3 gap-2">
          {[
            { id: 4, label: 'Small' },
            { id: 8, label: 'Medium' },
            { id: 14, label: 'Large' }
          ].map((size) => (
            <button
              key={size.id}
              onClick={() => setBaseRadius(size.id)}
              className={`p-2 rounded-md border text-xs font-medium transition-all
                ${baseRadius === size.id 
                  ? 'bg-blue-600/20 border-blue-500 text-blue-400' 
                  : 'bg-zinc-800/50 border-zinc-700 text-zinc-400 hover:border-zinc-600'}`}
            >
              {size.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between p-3 bg-zinc-800/30 rounded-lg border border-zinc-800">
        <Label className="text-zinc-300 text-xs font-medium">Reverse Direction</Label>
        <Switch.Root 
          className="w-9 h-5 bg-zinc-700 rounded-full relative data-[state=checked]:bg-blue-600" 
          checked={isReversed} 
          onCheckedChange={setIsReversed}
        >
          <Switch.Thumb className="block w-4 h-4 bg-white rounded-full transition-transform translate-x-0.5 data-[state=checked]:translate-x-[16px]" />
        </Switch.Root>
      </div>
    </CardContent>
  );
}

const SynapseControls = React.memo(function SynapseControls({ params, onChange, color }: { params: SynapseParams, onChange: (key: keyof SynapseParams, val: any) => void, color: 'green' | 'amber' }) {
  const colorClass = color === 'green' ? 'bg-green-600' : 'bg-amber-600';
  const textClass = color === 'green' ? 'text-green-400' : 'text-amber-400';
  return (
    <CardContent className="space-y-4">
      <div className="flex items-center justify-between p-3 bg-zinc-800/30 rounded-lg border border-zinc-800">
        <div className="space-y-0.5">
          <Label className="text-zinc-300 text-xs font-medium">Synaptic Action</Label>
          <p className="text-[10px] text-zinc-500">{params.isExcitatory ? 'Excitatory (+)' : 'Inhibitory (-)'}</p>
        </div>
        <Switch.Root
          className={`w-9 h-5 rounded-full relative transition-colors ${params.isExcitatory ? 'bg-green-600' : colorClass}`}
          checked={params.isExcitatory}
          onCheckedChange={(val) => onChange('isExcitatory', val)}
        >
          <Switch.Thumb className="block w-4 h-4 bg-white rounded-full transition-transform translate-x-0.5 data-[state=checked]:translate-x-[16px]" />
        </Switch.Root>
      </div>

      <div className="flex items-center justify-between p-3 bg-zinc-800/30 rounded-lg border border-zinc-800">
        <div className="space-y-0.5">
          <Label className="text-zinc-300 text-xs font-medium">Adaptation</Label>
          <p className="text-[10px] text-zinc-500">{params.isAdaptationEnabled ? 'Transient' : 'Sustained'}</p>
        </div>
        <Switch.Root
          className={`w-9 h-5 rounded-full relative transition-colors data-[state=checked]:bg-blue-600 bg-zinc-700`}
          checked={params.isAdaptationEnabled}
          onCheckedChange={(val) => onChange('isAdaptationEnabled', val)}
        >
          <Switch.Thumb className="block w-4 h-4 bg-white rounded-full transition-transform translate-x-0.5 data-[state=checked]:translate-x-[16px]" />
        </Switch.Root>
      </div>
      
      <div className="px-3 py-2 bg-zinc-800/20 rounded border border-zinc-800/50 flex justify-between items-center">
        <span className="text-[10px] text-zinc-500 font-medium uppercase">Synaptic Logic</span>
        <span className={`text-[10px] ${textClass} font-mono`}>FREQ: {params.frequency}Hz | TAU: {params.tau}ms</span>
      </div>
    </CardContent>
  );
});
