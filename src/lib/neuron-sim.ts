/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface SynapseParams {
  numSynapses: number;
  frequency: number; // Hz (Base rate)
  weight: number; // nS
  tau: number; // ms
  distance: number; // microns
  slope?: number; // Rate increase per unit of input activity
  inputActivity?: number[]; // Local activity corresponding to each synapse
  isExcitatory: boolean;
  isAdaptationEnabled?: boolean;
}

export interface SimulationParams {
  excitatory: SynapseParams;
  inhibitory: SynapseParams;
  spikeThreshold: number; // mV
  inhReversalPotential: number; // mV
  ahpWeight?: number; // nS increment per spike
  ahpTau?: number; // ms decay constant
}

export interface SpikeEvent {
  type: 'exc' | 'inh' | 'post';
  populationId?: 1 | 2; // 1: L1, 2: L2
  time: number;
  index?: number;
}

export interface SimulationState {
  time: number;
  vmSoma: number;
  vmDendrite: number[];
  excConductance: number;
  inhConductance: number;
  ahpConductance: number;
  spikes: SpikeEvent[];
  isSpiking: boolean;
}

export class NeuronSim {
  // Physical constants
  private readonly Rm = 20000; // Ohm*cm^2
  private readonly Cm = 1.0; // uF/cm^2
  private readonly Ra = 150; // Ohm*cm
  private readonly EL = -70; // mV
  private readonly EsynExc = 0; // mV
  private EsynInh = -90; // mV
  private readonly EAhp = -90; // mV

  // Geometry
  private readonly somaDiam = 10e-4; // cm (10 um)
  private readonly dendDiam = 2e-4; // cm (2 um)
  private readonly dendLength = 1000e-4; // cm (1000 um)
  private readonly numDendCompartments = 10;
  private readonly dx = this.dendLength / this.numDendCompartments;

  // Simulation state
  private v: number[]; // Voltages [soma, dend1, ..., dendN]
  private gExc: number[]; // Excitatory conductances
  private zExc: number[]; // Auxiliary for Exc
  private gInh: number[]; // Inhibitory conductances
  private zInh: number[]; // Auxiliary for Inh
  private gAhp = 0; // AHP conductance (soma only)
  private time = 0;
  private dt = 0.005; // ms

  // Postsynaptic spike state
  private isSpiking = false;
  private spikeTimeElapsed = 0;
  private spikeStartVm = 0;

  // Synapse info
  private excCompIndex: number = 0;
  private inhCompIndex: number = 0;
  private nextSpikeTimesExc: number[] = [];
  private nextSpikeTimesInh: number[] = [];

  constructor() {
    this.v = new Array(this.numDendCompartments + 1).fill(this.EL);
    this.gExc = new Array(this.numDendCompartments + 1).fill(0);
    this.zExc = new Array(this.numDendCompartments + 1).fill(0);
    this.gInh = new Array(this.numDendCompartments + 1).fill(0);
    this.zInh = new Array(this.numDendCompartments + 1).fill(0);
  }

  public getVmSoma(): number {
    return this.v[0];
  }

  public reset(params: SimulationParams) {
    this.v.fill(this.EL);
    this.gExc.fill(0);
    this.zExc.fill(0);
    this.gInh.fill(0);
    this.zInh.fill(0);
    this.gAhp = 0;
    this.time = 0;
    this.isSpiking = false;
    this.spikeTimeElapsed = 0;
    this.nextSpikeTimesExc = [];
    this.nextSpikeTimesInh = [];
    this.syncParams(params);
  }

  private syncParams(params: SimulationParams) {
    // Update locations
    this.EsynInh = params.inhReversalPotential;
    this.excCompIndex = Math.min(this.numDendCompartments, Math.floor((params.excitatory.distance / 1000) * this.numDendCompartments));
    this.inhCompIndex = Math.min(this.numDendCompartments, Math.floor((params.inhibitory.distance / 1000) * this.numDendCompartments));

    // Sync Exc spike trains
    if (this.nextSpikeTimesExc.length !== params.excitatory.numSynapses) {
      if (this.nextSpikeTimesExc.length < params.excitatory.numSynapses) {
        const extra = params.excitatory.numSynapses - this.nextSpikeTimesExc.length;
        for (let i = 0; i < extra; i++) {
          this.nextSpikeTimesExc.push(this.time + (-Math.log(Math.random()) / (params.excitatory.frequency / 1000)));
        }
      } else {
        this.nextSpikeTimesExc = this.nextSpikeTimesExc.slice(0, params.excitatory.numSynapses);
      }
    }

    // Sync Inh spike trains
    if (this.nextSpikeTimesInh.length !== params.inhibitory.numSynapses) {
      if (this.nextSpikeTimesInh.length < params.inhibitory.numSynapses) {
        const extra = params.inhibitory.numSynapses - this.nextSpikeTimesInh.length;
        for (let i = 0; i < extra; i++) {
          this.nextSpikeTimesInh.push(this.time + (-Math.log(Math.random()) / (params.inhibitory.frequency / 1000)));
        }
      } else {
        this.nextSpikeTimesInh = this.nextSpikeTimesInh.slice(0, params.inhibitory.numSynapses);
      }
    }
  }

  public step(params: SimulationParams): SimulationState[] {
    this.syncParams(params);

    const msToSimulate = 1.0;
    const pointsPerMs = 10; // 0.1ms resolution
    const stepsPerPoint = Math.floor((msToSimulate / pointsPerMs) / this.dt);
    const allStates: SimulationState[] = [];
    
    for (let p = 0; p < pointsPerMs; p++) {
      const spikes: SpikeEvent[] = [];
      for (let s = 0; s < stepsPerPoint; s++) {
        this.internalStep(params, spikes);
      }
      allStates.push({
        time: this.time,
        vmSoma: this.v[0],
        vmDendrite: this.v.slice(1),
        excConductance: this.gExc.reduce((a, b) => a + b, 0),
        inhConductance: this.gInh.reduce((a, b) => a + b, 0),
        ahpConductance: this.gAhp,
        spikes,
        isSpiking: this.isSpiking,
      });
    }

    if (isNaN(this.v[0])) {
      this.reset(params);
      return [];
    }

    return allStates;
  }

  private internalStep(params: SimulationParams, spikes: SpikeEvent[]) {
    const nextV = [...this.v];
    const n = this.v.length;
    const e = Math.exp(1);

    // 1. Update Synapses
    const dtSeconds = this.dt / 1000;

    const processPopulation = (p: SynapseParams, compIdx: number, popId: 1 | 2) => {
      for (let i = 0; i < p.numSynapses; i++) {
        const baseFreq = p.frequency;
        const slope = p.slope || 0;
        const activity = p.inputActivity ? (p.inputActivity[i] || 0) : 0;
        const normalizedActivity = activity / 255;
        const currentFreq = baseFreq + normalizedActivity * slope;

        if (Math.random() < currentFreq * dtSeconds) {
          if (p.isExcitatory) {
            this.zExc[compIdx] += (p.weight * 1e-9 * e);
            spikes.push({ type: 'exc', populationId: popId, time: this.time, index: i });
          } else {
            this.zInh[compIdx] += (p.weight * 1e-9 * e);
            spikes.push({ type: 'inh', populationId: popId, time: this.time, index: i });
          }
        }
      }
    };

    processPopulation(params.excitatory, this.excCompIndex, 2);
    processPopulation(params.inhibitory, this.inhCompIndex, 1);

    // 2. Update Conductances
    for (let i = 0; i < n; i++) {
      const dgExc = (this.zExc[i] - this.gExc[i]) / params.excitatory.tau;
      const dzExc = -this.zExc[i] / params.excitatory.tau;
      this.gExc[i] += dgExc * this.dt;
      this.zExc[i] += dzExc * this.dt;

      const dgInh = (this.zInh[i] - this.gInh[i]) / params.inhibitory.tau;
      const dzInh = -this.zInh[i] / params.inhibitory.tau;
      this.gInh[i] += dgInh * this.dt;
      this.zInh[i] += dzInh * this.dt;
    }

    // Update AHP conductance
    const ahpTau = params.ahpTau || 100;
    this.gAhp += (-this.gAhp / ahpTau) * this.dt;

    // 3. Update Voltages or Handle Spike
    if (this.isSpiking) {
      this.spikeTimeElapsed += this.dt;
      if (this.spikeTimeElapsed <= 0.5) {
        // Linear rise from start to +10
        const progress = this.spikeTimeElapsed / 0.5;
        nextV[0] = this.spikeStartVm + (10 - this.spikeStartVm) * progress;
      } else if (this.spikeTimeElapsed <= 2.0) {
        // Linear fall from +10 to -80
        const progress = (this.spikeTimeElapsed - 0.5) / 1.5;
        nextV[0] = 10 + (-80 - 10) * progress;
      } else if (this.spikeTimeElapsed <= 5.0) {
        // Hold at -80 for 3ms (refractory period)
        nextV[0] = -80;
      } else {
        // Spike finished
        this.isSpiking = false;
        this.spikeTimeElapsed = 0;
        nextV[0] = -80;
      }
      // Dendrites stay at previous values (paused) during spike
    } else {
      // Normal integration
      for (let i = 0; i < n; i++) {
        let area = (i === 0) ? 4 * Math.PI * Math.pow(this.somaDiam / 2, 2) : Math.PI * this.dendDiam * this.dx;
        const cap = this.Cm * 1e-6 * area;
        const leakG = (1 / this.Rm) * area;

        let iAxial = 0;
        const rAxial = (this.Ra * this.dx) / (Math.PI * Math.pow(this.dendDiam / 2, 2));
        if (i > 0) iAxial += (this.v[i-1] - this.v[i]) / rAxial;
        if (i < n - 1) iAxial += (this.v[i+1] - this.v[i]) / rAxial;

        const iLeak = leakG * (this.EL - this.v[i]);
        const iSynExc = this.gExc[i] * (this.EsynExc - this.v[i]);
        const iSynInh = this.gInh[i] * (this.EsynInh - this.v[i]);
        
        // Add AHP current to Soma
        let iAhp = 0;
        if (i === 0) {
          iAhp = this.gAhp * (this.EAhp - this.v[0]);
        }

        const dv = (iLeak + iAxial + iSynExc + iSynInh + iAhp) / cap;
        nextV[i] += dv * (this.dt / 1000);
      }

      // Check for threshold crossing
      if (nextV[0] >= params.spikeThreshold) {
        this.isSpiking = true;
        this.spikeTimeElapsed = 0;
        this.spikeStartVm = nextV[0];
        
        // Increment AHP
        this.gAhp += (params.ahpWeight || 20) * 1e-9;
        
        spikes.push({ type: 'post', time: this.time });
      }
    }

    this.v = nextV;
    this.time += this.dt;
  }
}
