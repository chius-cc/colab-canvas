"""Loads declarative workflow packs and renders patched ComfyUI API graphs."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import yaml
from fastapi import HTTPException, status
from pydantic import BaseModel, Field


class WeightSpec(BaseModel):
    repo_id: str
    repo_path: str
    target_path: str
    sha256: str
    size_bytes: int


class VariantDefaults(BaseModel):
    steps: int
    cfg: float
    sampler_name: str
    scheduler: str
    positive_prefix: str = ""
    negative_prompt: str = ""


class VariantSpec(BaseModel):
    label: str
    description: str = ""
    admin_only: bool = False
    weight: WeightSpec
    defaults: VariantDefaults


class ResolutionPreset(BaseModel):
    id: str
    label: str
    width: int
    height: int


class ParamBounds(BaseModel):
    min_dimension: int = 512
    max_dimension: int = 1536
    dimension_step: int = 64
    min_steps: int = 1
    max_steps: int = 60
    min_cfg: float = 1.0
    max_cfg: float = 12.0
    max_batch_size: int = 4
    allowed_samplers: list[str]
    allowed_schedulers: list[str]


class WorkflowManifest(BaseModel):
    id: str
    name: str
    description: str = ""
    comfyui_commit: str
    default_gpu: str = "L4"
    prompt_hint: str = ""
    supports_loras: bool = True
    max_loras: int = 4
    shared_weights: list[WeightSpec] = Field(default_factory=list)
    default_variant: str
    variants: dict[str, VariantSpec]
    resolution_presets: list[ResolutionPreset] = Field(default_factory=list)
    bounds: ParamBounds


class LoraSelection(BaseModel):
    filename: str
    strength: float = Field(default=0.8, ge=-2.0, le=2.0)


class LoadedWorkflow:
    def __init__(self, manifest: WorkflowManifest, template_graph: dict[str, Any]) -> None:
        self.manifest = manifest
        self.template_graph = template_graph


class WorkflowRegistry:
    """Loads `workflows/*/manifest.yaml` and `workflow_api.json` packs."""

    def __init__(self, workflows_dir: Path) -> None:
        self.workflows_dir = workflows_dir
        self._workflows: dict[str, LoadedWorkflow] = {}
        self.reload()

    def reload(self) -> None:
        self._workflows.clear()
        if not self.workflows_dir.exists():
            return
        for pack_dir in sorted(self.workflows_dir.iterdir()):
            if not pack_dir.is_dir():
                continue
            manifest_path = pack_dir / "manifest.yaml"
            graph_path = pack_dir / "workflow_api.json"
            if not manifest_path.is_file() or not graph_path.is_file():
                continue
            raw_manifest = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
            manifest = WorkflowManifest.model_validate(raw_manifest)
            graph = json.loads(graph_path.read_text(encoding="utf-8"))
            self._workflows[manifest.id] = LoadedWorkflow(manifest, graph)

    def get(self, workflow_id: str) -> LoadedWorkflow:
        wf = self._workflows.get(workflow_id)
        if wf is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Workflow '{workflow_id}' not found",
            )
        return wf

    def list_for_user(self, *, is_admin: bool) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for wf in self._workflows.values():
            m = wf.manifest.model_copy(deep=True)
            visible_variants = {
                k: v for k, v in m.variants.items() if (is_admin or not v.admin_only)
            }
            data = m.model_dump()
            data["variants"] = {k: v.model_dump() for k, v in visible_variants.items()}
            items.append(data)
        return items

    def render_prompt_graph(
        self,
        *,
        workflow_id: str,
        variant: str,
        is_admin: bool,
        prompt: str,
        negative_prompt: str | None = None,
        width: int = 1024,
        height: int = 1024,
        batch_size: int = 1,
        steps: int | None = None,
        cfg: float | None = None,
        sampler_name: str | None = None,
        scheduler: str | None = None,
        seed: int = 42,
        loras: list[LoraSelection] | None = None,
        filename_prefix: str = "colab_canvas",
    ) -> dict[str, Any]:
        wf = self.get(workflow_id)
        m = wf.manifest

        vspec = m.variants.get(variant)
        if vspec is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unknown variant '{variant}' for workflow '{workflow_id}'",
            )
        if vspec.admin_only and not is_admin:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Variant '{variant}' requires admin privileges",
            )

        b = m.bounds
        for dim_name, dim_val in (("width", width), ("height", height)):
            if not (b.min_dimension <= dim_val <= b.max_dimension) or (
                dim_val % b.dimension_step != 0
            ):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        f"{dim_name} must be between {b.min_dimension} and {b.max_dimension} "
                        f"in steps of {b.dimension_step}"
                    ),
                )

        if not (1 <= batch_size <= b.max_batch_size):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"batch_size must be between 1 and {b.max_batch_size}",
            )

        eff_steps = steps if steps is not None else vspec.defaults.steps
        eff_cfg = cfg if cfg is not None else vspec.defaults.cfg
        eff_sampler = sampler_name or vspec.defaults.sampler_name
        eff_scheduler = scheduler or vspec.defaults.scheduler
        eff_negative = (
            negative_prompt if negative_prompt is not None else vspec.defaults.negative_prompt
        )

        if not (b.min_steps <= eff_steps <= b.max_steps):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"steps must be between {b.min_steps} and {b.max_steps}",
            )
        if not (b.min_cfg <= eff_cfg <= b.max_cfg):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"cfg must be between {b.min_cfg} and {b.max_cfg}",
            )
        if eff_sampler not in b.allowed_samplers:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unsupported sampler '{eff_sampler}'",
            )
        if eff_scheduler not in b.allowed_schedulers:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unsupported scheduler '{eff_scheduler}'",
            )

        lora_list = loras or []
        if lora_list and not m.supports_loras:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Workflow '{workflow_id}' does not support LoRAs",
            )
        if len(lora_list) > m.max_loras:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"At most {m.max_loras} LoRAs supported per generation",
            )

        graph = copy.deepcopy(wf.template_graph)
        graph["1"]["inputs"]["unet_name"] = Path(vspec.weight.target_path).name
        graph["4"]["inputs"]["text"] = prompt
        graph["5"]["inputs"]["text"] = eff_negative
        graph["6"]["inputs"]["width"] = width
        graph["6"]["inputs"]["height"] = height
        graph["6"]["inputs"]["batch_size"] = batch_size

        model_ref: list[Any] = ["1", 0]
        for idx, lora in enumerate(lora_list):
            node_id = str(100 + idx)
            graph[node_id] = {
                "class_type": "LoraLoaderModelOnly",
                "inputs": {
                    "model": model_ref,
                    "lora_name": lora.filename,
                    "strength_model": lora.strength,
                },
            }
            model_ref = [node_id, 0]

        graph["7"]["inputs"]["model"] = model_ref
        graph["7"]["inputs"]["seed"] = seed
        graph["7"]["inputs"]["steps"] = eff_steps
        graph["7"]["inputs"]["cfg"] = eff_cfg
        graph["7"]["inputs"]["sampler_name"] = eff_sampler
        graph["7"]["inputs"]["scheduler"] = eff_scheduler
        graph["9"]["inputs"]["filename_prefix"] = filename_prefix
        return graph
