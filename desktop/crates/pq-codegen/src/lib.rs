use pq_model::*;

fn py(s: &str) -> String { format!("{:?}", s) }
fn py_list(v: &[String]) -> String { format!("[{}]", v.iter().map(|s| py(s)).collect::<Vec<_>>().join(", ")) }

pub fn step_to_python(k: &StepKind) -> Option<String> {
    use StepKind::*;
    Some(match k {
        SelectColumns { cols } => format!(".select({})", py_list(cols)),
        RemoveColumns { cols } => format!(".drop({})", py_list(cols)),
        ReorderColumns { cols } => format!(".select(pl.col({0}), pl.exclude({0}))", py_list(cols)),
        Rename { map } => format!(".rename({{{}}})", map.iter().map(|(a, b)| format!("{}: {}", py(a), py(b))).collect::<Vec<_>>().join(", ")),
        Sort { by } => format!(".sort({}, descending=[{}], nulls_last=True, maintain_order=True)", py_list(&by.iter().map(|b| b.col.clone()).collect::<Vec<_>>()), by.iter().map(|b| if b.desc { "True" } else { "False" }).collect::<Vec<_>>().join(", ")),
        Distinct { subset } if subset.is_empty() => ".unique(keep=\"first\", maintain_order=True)".into(),
        Distinct { subset } => format!(".unique(subset={}, keep=\"first\", maintain_order=True)", py_list(subset)),
        FillDown { cols } => format!(".with_columns(pl.col({}).forward_fill())", py_list(cols)),
        FillUp { cols } => format!(".with_columns(pl.col({}).backward_fill())", py_list(cols)),
        Checkpoint => ".collect().lazy()  # checkpoint".into(),
        CustomSql { sql } => format!(".pipe(lambda LF: pl.SQLContext({{\"self\": LF}}).execute({}))", py(sql)),
        _ => return None,
    })
}

pub fn query_to_python(q: &Query) -> String {
    let mut out = format!("{} = (\n    pl.LazyFrame()  # source\n", snake(&q.name));
    for s in q.steps.iter().skip(1).filter(|s| s.disabled != Some(true)) {
        out += &format!("    # {}\n", s.name);
        out += &format!("    {}\n", step_to_python(&s.kind).unwrap_or_else(|| format!("# TODO port {} from js/steps.js", s.name)));
    }
    out + ")\n"
}
