{{/* Chart name (overridable). */}}
{{- define "cw.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Fully-qualified release name. */}}
{{- define "cw.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "cw.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "cw.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Common labels. */}}
{{- define "cw.labels" -}}
helm.sh/chart: {{ include "cw.chart" . }}
app.kubernetes.io/name: {{ include "cw.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* Selector labels for a given component (pass dict with .ctx and .component). */}}
{{- define "cw.selectorLabels" -}}
app.kubernetes.io/name: {{ include "cw.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "cw.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "cw.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* Name of the secret to mount as env (existing or chart-created). */}}
{{- define "cw.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "cw.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/* Pod-level scheduling knobs, applied to every app workload. */}}
{{- define "cw.scheduling" -}}
{{- with .Values.scheduling }}
{{- with .nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .topologySpreadConstraints }}
topologySpreadConstraints:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}
{{- end -}}

{{/* Chart-wide pod selector (all components of this release). */}}
{{- define "cw.releaseSelector" -}}
app.kubernetes.io/name: {{ include "cw.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
