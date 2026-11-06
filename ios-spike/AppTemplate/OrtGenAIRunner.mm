// NOT COMPILED OR RUN in the environment that produced it (no Mac / Xcode). See OrtGenAIRunner.h.
#import "OrtGenAIRunner.h"

#include <chrono>
#include <memory>
#include <stdexcept>
#include <string>

#include "ort_genai.h"  // from the same onnxruntime-genai build as the static library you link

static NSString *const kErrorDomain = @"FieldVoice.OrtGenAI";

static NSError *MakeError(const std::exception &e) {
  return [NSError errorWithDomain:kErrorDomain
                             code:1
                         userInfo:@{NSLocalizedDescriptionKey : [NSString stringWithUTF8String:e.what()]}];
}

@implementation OrtGenAIResult
@end

@interface OrtGenAIRunner () {
  std::unique_ptr<OgaModel> _model;
  std::unique_ptr<OgaTokenizer> _tokenizer;
}
@end

@implementation OrtGenAIRunner

- (nullable instancetype)initWithModelPath:(NSString *)modelPath error:(NSError **)error {
  if ((self = [super init])) {
    try {
      _model = OgaModel::Create(modelPath.UTF8String);
      _tokenizer = OgaTokenizer::Create(*_model);
    } catch (const std::exception &e) {
      if (error) *error = MakeError(e);
      return nil;
    }
  }
  return self;
}

- (nullable OrtGenAIResult *)generateWithSystem:(NSString *)system
                                           user:(NSString *)user
                                      maxTokens:(NSInteger)maxTokens
                                        grammar:(nullable NSString *)larkGrammar
                                          error:(NSError **)error {
  using Clock = std::chrono::steady_clock;
  auto ms = [](Clock::time_point a, Clock::time_point b) {
    return std::chrono::duration<double, std::milli>(b - a).count();
  };
  try {
    // chat template -> prompt text (falls back to plain concatenation for models without a template)
    NSArray *messages = @[ @{@"role" : @"system", @"content" : system}, @{@"role" : @"user", @"content" : user} ];
    NSData *json = [NSJSONSerialization dataWithJSONObject:messages options:0 error:nil];
    NSString *messagesJson = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    std::string prompt;
    try {
      OgaString templated = _tokenizer->ApplyChatTemplate(nullptr, messagesJson.UTF8String, nullptr, true);
      prompt = static_cast<const char *>(templated);
    } catch (const std::exception &) {
      prompt = std::string(system.UTF8String) + "\n\n" + user.UTF8String;
    }

    auto sequences = OgaSequences::Create();
    _tokenizer->Encode(prompt.c_str(), *sequences);
    const size_t promptTokens = sequences->SequenceCount(0);

    auto params = OgaGeneratorParams::Create(*_model);
    params->SetSearchOption("max_length", static_cast<double>(promptTokens + static_cast<size_t>(maxTokens)));
    params->SetSearchOption("batch_size", 1);
    if (larkGrammar.length > 0) {
      // needs a build with guidance (llguidance); the prebuilt iOS framework has none and throws "Guidance is unavailable
      // in this build", which the catch below returns as an NSError
      params->SetGuidance("lark_grammar", larkGrammar.UTF8String);
    }

    auto generator = OgaGenerator::Create(*_model, *params);
    auto stream = OgaTokenizerStream::Create(*_tokenizer);

    std::string text;
    size_t produced = 0;
    double ttft = 0;
    const auto t0 = Clock::now();
    generator->AppendTokenSequences(*sequences);
    while (!generator->IsDone()) {
      generator->GenerateNextToken();
      if (produced == 0) ttft = ms(t0, Clock::now());
      const int32_t token = generator->GetNextTokens()[0];
      if (const char *piece = stream->Decode(token)) text += piece;
      ++produced;
    }
    const double total = ms(t0, Clock::now());

    OrtGenAIResult *result = [OrtGenAIResult new];
    result.text = [NSString stringWithUTF8String:text.c_str()] ?: @"";
    result.promptTokens = static_cast<NSInteger>(promptTokens);
    result.outputTokens = static_cast<NSInteger>(produced);
    result.ttftMs = ttft;
    result.totalMs = total;
    return result;
  } catch (const std::exception &e) {
    if (error) *error = MakeError(e);
    return nil;
  }
}

@end
