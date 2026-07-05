---
title: "mistral-nemotron"
publisher: "mistralai"
type: "endpoint"
updated: "2025-06-12T03:42:45.008Z"
description: "Built for agentic workflows, this model excels in coding, instruction following, and function calling"
canonical: "https://build.nvidia.com/mistralai/mistral-nemotron"
---

# Mistral-Nemotron Overview

## Description:

Mistral-Nemotron is a large language model produced by Mistral and optimised by NVIDIA that generates human-like text and can be used for a variety of natural language processing tasks, such as text generation, language translation, and text summarization. It is also suitable for Agentic workflows due to its tool calling capabilities.

This model is ready for commercial usage.

## Third-Party Community Consideration <br>  
This model is not owned or developed by NVIDIA. This model has been developed and built to a third-partyΓÇÖs requirements for this application and use case; more information available on the model [here](https://mistral.ai/models) (scroll past animation).

## License/Terms of Use:  
Access to this model is governed by the NVIDIA [API Trial Terms of Service](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf).

To deploy and customize Mistral models with NIMs in your environment, please contact Mistral AI to acquire necessary licenses at [https://mistral.ai/license-mistral-models-for-nvidia-inference-microservices](https://mistral.ai/license-mistral-models-for-nvidia-inference-microservices).

Use of this model is subject to compliance with all applicable laws, and users are responsible for ensuring such compliance."

## Deployment Geography:  
Global

## Use Case:  
Researchers and developers in the field of natural language processing (NLP) and artificial intelligence (AI) may use the Mistral-Nemotron model for tasks such as language translation, text summarization, and conversational AI applications.

## Release Date:  
Release Date on Build.NVIDIA.com:  
"06/11/2025, [https://build.nvidia.com/mistralai/mistral-nemotron](https://build.nvidia.com/mistralai/mistral-nemotron)"

## Model Architecture:

- Architecture Type:  
- Transformer  
- Network Architecture:  
- Modified Transformer

## Input:

- Input Type(s):  
- Text  
- Input Format(s):  
- String  
- Input Parameters:  
- One-Dimensional (1D)  
- Other Properties Related to Input:  
- 128K Maximum Context Length

## Output:

- Output Type:  
- Text  
- Output Format:  
- String  
- Output Parameters:  
- One-Dimensional (1D)  
- Other Properties Related to Output:  
- Maximum Context Length 128K

Software Integration:  
Runtime Engine(s):  
\['TensorRT-LLM', 'vLLM'\]

Supported Hardware Microarchitecture Compatibility:  
\['NVIDIA Hopper'\]

\[Preferred/Supported\] Operating System(s):  
\['Linux'\]

Model Version(s):  
{'v1'}

Training, Testing, and Evaluation Datasets:

Benchmark Score:

## Coding & Programming  
| Benchmark | Score |  
|-----------|-------|  
| HumanEval Instruct 0-shot pass@1 | 92.68 |  
| LiveCodeBench (v6) 0-shot | 27.42 |

## Instruction Following  
| Benchmark | Score |  
|-----------|-------|  
| IfEval 0-shot | 87.33 |

## Mathematics  
| Benchmark | Score |  
|-----------|-------|  
| MATH Instruct 0-shot | 91.14 |

## General Knowledge & Reasoning  
| Benchmark | Score |  
|-----------|-------|  
| MMLU Pro Instruct 5-shot CoT | 73.81 |

## MMLU by Language  
| Language | Benchmark | Score |  
|----------|-----------|-------|  
| English | MMLU Instruct 5-shot | 84.84 |  
| Chinese | CMMLU Instruct 5-shot | 80.54 |  
| Japanese | JMMLU Instruct 5-shot | 80.85 |  
| Korean | KMMLU Instruct 5-shot | 64.56 |  
| French | Fr MMLU 5-shot | 82.99 |  
| German | De MMLU 5-shot | 81.99 |  
| Spanish | Es MMLU 5-shot | 83.61 |  
| Italian | It MMLU 5-shot | 83.74 |  
| Russian | Ru MMLU 5-shot | 80.73 |

Data Collection Method by dataset

- Hybrid: Automated, Human, Synthetic

Labeling Method by dataset

- Hybrid: Automated, Human, Synthetic

Inference:

- Engine:  
- TensorRT-LLM, vLLM

Test Hardware :

- H100

Ethical Considerations:  
NVIDIA believes Trustworthy AI is a shared responsibility and we have established policies and practices to enable development for a wide array of AI applications. When downloaded or used in accordance with our terms of service, developers should work with their internal model team to ensure this model meets requirements for the relevant industry and use case and addresses unforeseen product misuse.

Please report security vulnerabilities or NVIDIA AI Concerns [here](https://www.nvidia.com/en-us/support/submit-security-vulnerability/)

## Prototype

```python
from openai import OpenAI

client = OpenAI(
base_url = "https://integrate.api.nvidia.com/v1",
api_key = "$NVIDIA_API_KEY"
)

completion = client.chat.completions.create(
model="",
messages=[{"role":"user","content":""}],
temperature=,
top_p=,
max_tokens=,
stream=NaN
)

print(completion.choices[0].message)
```

```python
from langchain_nvidia_ai_endpoints import ChatNVIDIA

client = ChatNVIDIA(
model="",
api_key="$NVIDIA_API_KEY", 
temperature=,
top_p=,
max_tokens=,
)

response = client.invoke([{"role":"user","content":""}])
print(response.content)
```

```javascript
import OpenAI from 'openai';

const openai = new OpenAI({
apiKey: '$NVIDIA_API_KEY',
baseURL: 'https://integrate.api.nvidia.com/v1',
})

async function main() {
const completion = await openai.chat.completions.create({
model: "",
messages: [{"role":"user","content":""}],
temperature: ,
top_p: ,
max_tokens: ,
stream: 
})

process.stdout.write(completion.choices[0]?.message?.content);

}

main();
```

```bash
invoke_url='https://integrate.api.nvidia.com/v1/chat/completions'

authorization_header='Authorization: Bearer '
accept_header='Accept: application/json'
content_type_header='Content-Type: application/json'

data=$'{
"messages": [
{
"role": "user",
"content": ""
}
]
}'

response=$(curl --silent -i -w "\n%{http_code}" --request POST \
--url "$invoke_url" \
--header "$authorization_header" \
--header "$accept_header" \
--header "$content_type_header" \
--data "$data"
)

echo "$response"
```
